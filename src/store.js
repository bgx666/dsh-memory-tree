/**
 * Durable memory tree, one SQLite database for every session of this install.
 *
 * The session id is the partition key, which is exactly the role `character_id`
 * plays in planner's `SQLiteMemoryTree`. Nodes are append-only: a merge never
 * deletes children, it marks them inactive and points them at their parent, so
 * `explore_memory_tree` can still drill into what the parent replaced.
 *
 * @module @xiaob/dsh-memory-tree/store
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  session_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  level      INTEGER NOT NULL DEFAULT 0,
  summary    TEXT NOT NULL,
  parent_id  TEXT,
  msg_start  INTEGER NOT NULL DEFAULT 0,
  msg_end    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  is_active  INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT,
  details    TEXT,
  meta       TEXT,
  time_start TEXT,
  time_end   TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nodes_dedupe
  ON nodes(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_nodes_active ON nodes(session_id, level, is_active);
CREATE INDEX IF NOT EXISTS ix_nodes_parent ON nodes(session_id, parent_id);
CREATE TABLE IF NOT EXISTS keeps (
  session_id TEXT NOT NULL,
  checkpoint INTEGER NOT NULL,
  keys       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session_id, checkpoint)
);
`

/** Resolve the Harness home the same way `resolveDshHome()` does. */
export function harnessHome() {
  const explicit = process.env['DSH_HOME']
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  return join(homedir(), '.dsh')
}

/** Absolute path of the memory-tree database. */
export function defaultDbPath() {
  const override = process.env['DSH_MEMORY_TREE_DB']
  if (typeof override === 'string' && override.trim() !== '') return override
  return join(harnessHome(), 'memory-tree', 'memory_tree.db')
}

/** Columns read back from `nodes`; `meta` is parsed into `meta.fields`. */
const COLUMNS = 'id, level, summary, parent_id, msg_start, msg_end, created_at, '
  + 'is_active, details, meta, time_start, time_end'

/** Decode one row's JSON columns. */
function decode(row) {
  if (row === undefined || row === null) return undefined
  const copy = { ...row }
  if (typeof copy['details'] === 'string') {
    try {
      copy['details'] = JSON.parse(copy['details'])
    } catch {
      copy['details'] = []
    }
  }
  if (typeof copy['meta'] === 'string') {
    try {
      copy['meta'] = JSON.parse(copy['meta'])
    } catch {
      copy['meta'] = {}
    }
  }
  if (copy['meta'] === null || copy['meta'] === undefined) copy['meta'] = {}
  return copy
}

export class MemoryTreeStore {
  /** @type {import('node:sqlite').DatabaseSync | null} */
  #db = null
  /** @type {Map<string, Map<number, number>>} */
  #counters = new Map()
  /** @type {string} */
  #path

  /** @param {string} [path] database file; defaults to `$DSH_HOME/memory-tree/memory_tree.db`. */
  constructor(path = defaultDbPath()) {
    this.#path = path
  }

  /** Absolute database path. */
  get path() {
    return this.#path
  }

  /** Open, migrate, and cache the database handle. */
  #open() {
    if (this.#db !== null) return this.#db
    mkdirSync(dirname(this.#path), { recursive: true })
    const db = new DatabaseSync(this.#path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(SCHEMA)
    this.#migrate(db)
    this.#db = db
    return db
  }

  /**
   * Add the columns a pre-existing database predates.
   *
   * The first generation of this plugin stored neither `meta` nor a time range;
   * old rows keep working (they render as summary-only nodes), so migration adds
   * columns rather than rewriting or dropping anything.
   * @param {import('node:sqlite').DatabaseSync} db open handle.
   * @returns {void}
   */
  #migrate(db) {
    const existing = new Set(db.prepare('PRAGMA table_info(nodes)').all()
      .map(column => String(column['name'])))
    for (const [column, type] of [['meta', 'TEXT'], ['time_start', 'TEXT'], ['time_end', 'TEXT']]) {
      if (!existing.has(column)) db.exec(`ALTER TABLE nodes ADD COLUMN ${column} ${type}`)
    }
  }

  /** Release the SQLite handle. */
  close() {
    if (this.#db === null) return
    this.#db.close()
    this.#db = null
  }

  /**
   * Allocate the next id for a level, e.g. `node1_004`.
   * @param {string} sessionId partition key.
   * @param {number} level tree level.
   * @returns {string} the new node id.
   */
  #nextId(sessionId, level) {
    let levels = this.#counters.get(sessionId)
    if (levels === undefined) {
      levels = new Map()
      this.#counters.set(sessionId, levels)
    }
    let next = levels.get(level)
    if (next === undefined) {
      const row = this.#open()
        .prepare('SELECT id FROM nodes WHERE session_id = ? AND level = ? ORDER BY id DESC LIMIT 1')
        .get(sessionId, level)
      next = row === undefined
        ? 0
        : Number.parseInt(String(row['id']).slice(`node${level}_`.length), 10) || 0
    }
    const value = next + 1
    levels.set(level, value)
    return `node${level}_${String(value).padStart(3, '0')}`
  }

  /** Next message ordinal not yet covered by any node of this session. */
  #nextOrdinal(sessionId) {
    const row = this.#open()
      .prepare('SELECT MAX(msg_end) AS m FROM nodes WHERE session_id = ?')
      .get(sessionId)
    const max = row?.['m']
    return max === null || max === undefined ? 1 : Number(max) + 1
  }

  /** Next message ordinal not yet covered by any node of this session. */
  nextOrdinal(sessionId) {
    return this.#nextOrdinal(sessionId)
  }

  /** Whether a leaf with this dedupe key already exists. */
  hasLeaf(sessionId, dedupeKey) {
    const row = this.#open()
      .prepare('SELECT id FROM nodes WHERE session_id = ? AND dedupe_key = ?')
      .get(sessionId, dedupeKey)
    return row !== undefined
  }

  /**
   * Append one level-0 node.
   * @param {object} leaf
   * @param {string} leaf.sessionId owning session.
   * @param {string} leaf.summary node text.
   * @param {Array<{role: string, content: unknown}>} leaf.details the summarized messages.
   * @param {object} leaf.meta `{schema_version, fields}` payload.
   * @param {number} leaf.count how many messages it covers.
   * @param {string} [leaf.dedupeKey] content hash, unique per session.
   * @param {[string, string] | null} [leaf.timeRange] start/end timestamps.
   * @returns {string} the new id.
   */
  addLeaf({ sessionId, summary, details, meta, count, dedupeKey, timeRange }) {
    const id = this.#nextId(sessionId, 0)
    const start = this.#nextOrdinal(sessionId)
    const [timeStart, timeEnd] = Array.isArray(timeRange) ? timeRange : [null, null]
    this.#open()
      .prepare(`INSERT INTO nodes
        (session_id, id, level, summary, msg_start, msg_end, dedupe_key, details, meta, time_start, time_end)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, id, summary, start, start + Math.max(0, count - 1),
        dedupeKey ?? null, JSON.stringify(details ?? []), JSON.stringify(meta ?? {}),
        timeStart, timeEnd)
    return id
  }

  /**
   * Merge several nodes into one new parent and deactivate the children.
   * @param {object} merge
   * @param {string} merge.sessionId owning session.
   * @param {string[]} merge.childIds nodes to merge, oldest first.
   * @param {string} merge.summary the parent's text.
   * @param {object} [merge.meta] parent `{schema_version, fields}` payload.
   * @returns {string} the parent id.
   */
  merge({ sessionId, childIds, summary, meta }) {
    if (childIds.length === 0) throw new Error('merge: childIds must not be empty')
    const db = this.#open()
    const rows = childIds.map(childId => {
      const row = db.prepare('SELECT level, msg_start, msg_end, time_start, time_end FROM nodes WHERE session_id = ? AND id = ?')
        .get(sessionId, childId)
      if (row === undefined) throw new Error(`merge: unknown node ${childId}`)
      return row
    })
    const level = Number(rows[0]['level']) + 1
    const parentId = this.#nextId(sessionId, level)
    const start = Math.min(...rows.map(row => Number(row['msg_start'])))
    const end = Math.max(...rows.map(row => Number(row['msg_end'])))
    const starts = rows.map(row => row['time_start']).filter(value => typeof value === 'string' && value !== '')
    const ends = rows.map(row => row['time_end']).filter(value => typeof value === 'string' && value !== '')
    db.prepare(`INSERT INTO nodes
      (session_id, id, level, summary, msg_start, msg_end, meta, time_start, time_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, parentId, level, summary, start, end,
        JSON.stringify(meta ?? {}), starts[0] ?? null, ends[ends.length - 1] ?? null)
    const detach = db.prepare('UPDATE nodes SET parent_id = ?, is_active = 0 WHERE session_id = ? AND id = ?')
    for (const childId of childIds) detach.run(parentId, sessionId, childId)
    return parentId
  }

  /**
   * Undo a compaction run whose checkpoint was never committed.
   *
   * A background run writes nodes before the session can be mutated, so a
   * failed or superseded commit would otherwise leave summaries that no
   * checkpoint covers. Deleting the run's nodes and re-activating their
   * children restores the tree the next run expects to read.
   * @param {string} sessionId owning session.
   * @param {string[]} nodeIds every node that run created, parents included.
   * @returns {void}
   */
  rollback(sessionId, nodeIds) {
    const ids = [...new Set((nodeIds ?? []).filter(id => typeof id === 'string' && id !== ''))]
    if (ids.length === 0) return
    const db = this.#open()
    const marks = ids.map(() => '?').join(',')
    db.prepare(`UPDATE nodes SET parent_id = NULL, is_active = 1
                WHERE session_id = ? AND parent_id IN (${marks})`)
      .run(sessionId, ...ids)
    db.prepare(`DELETE FROM nodes WHERE session_id = ? AND id IN (${marks})`)
      .run(sessionId, ...ids)
  }

  /** Active nodes at one level, oldest first. */
  activeAtLevel(sessionId, level) {
    return this.#open()
      .prepare(`SELECT ${COLUMNS} FROM nodes
                WHERE session_id = ? AND level = ? AND is_active = 1
                ORDER BY msg_start, id`)
      .all(sessionId, level)
      .map(decode)
  }

  /** Active nodes no parent supersedes, oldest first: what the checkpoint shows. */
  roots(sessionId) {
    return this.#open()
      .prepare(`SELECT ${COLUMNS} FROM nodes
                WHERE session_id = ? AND is_active = 1 AND parent_id IS NULL
                ORDER BY msg_start, id`)
      .all(sessionId)
      .map(decode)
  }

  /** Children of one node, oldest first. */
  children(sessionId, nodeId) {
    return this.#open()
      .prepare(`SELECT ${COLUMNS} FROM nodes
                WHERE session_id = ? AND parent_id = ? ORDER BY msg_start, id`)
      .all(sessionId, nodeId)
      .map(decode)
  }

  /** One node, or undefined. */
  node(sessionId, nodeId) {
    return decode(this.#open()
      .prepare(`SELECT ${COLUMNS} FROM nodes WHERE session_id = ? AND id = ?`)
      .get(sessionId, nodeId))
  }

  /** Session ids owning at least one node, most recently written first. */
  sessions() {
    return this.#open()
      .prepare(`SELECT session_id, MAX(created_at) AS last FROM nodes
                GROUP BY session_id ORDER BY last DESC`)
      .all()
      .map(row => String(row['session_id']))
  }

  /**
   * Persist the Chat rows left uncompressed by one checkpoint.
   * @param {string} sessionId owning session.
   * @param {number} checkpoint replacement `user/message` seq.
   * @param {readonly string[]} keys retained Chat row keys.
   * @returns {void}
   */
  setKeep(sessionId, checkpoint, keys) {
    this.#open()
      .prepare(`INSERT INTO keeps (session_id, checkpoint, keys) VALUES (?, ?, ?)
                ON CONFLICT(session_id, checkpoint) DO UPDATE SET keys = excluded.keys`)
      .run(sessionId, checkpoint, JSON.stringify(keys ?? []))
  }

  /**
   * Read one checkpoint's retained Chat row keys.
   * @param {string} sessionId owning session.
   * @param {number} checkpoint replacement `user/message` seq.
   * @returns {string[] | null} keys, or null when this checkpoint has no record.
   */
  getKeep(sessionId, checkpoint) {
    const row = this.#open()
      .prepare('SELECT keys FROM keeps WHERE session_id = ? AND checkpoint = ?')
      .get(sessionId, checkpoint)
    if (row === undefined) return null
    try {
      const keys = JSON.parse(String(row['keys']))
      return Array.isArray(keys) ? keys.map(String) : null
    } catch {
      return null
    }
  }

  /** Tree statistics for one session. */
  stats(sessionId) {
    const row = this.#open()
      .prepare(`SELECT COUNT(*) AS total,
                       SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
                       MAX(level) AS depth,
                       MAX(msg_end) AS covered
                FROM nodes WHERE session_id = ?`)
      .get(sessionId)
    return {
      total: Number(row?.['total'] ?? 0),
      active: Number(row?.['active'] ?? 0),
      depth: row?.['depth'] === null || row?.['depth'] === undefined ? -1 : Number(row['depth']),
      covered: Number(row?.['covered'] ?? 0),
    }
  }
}
