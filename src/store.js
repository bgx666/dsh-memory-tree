/**
 * Durable memory tree, one SQLite database for every session of this install.
 *
 * The session id is the partition key. Nodes are append-only: a merge never
 * deletes children, it marks them inactive and points them at their parent, so
 * `explore_memory_tree` can still drill into what the parent replaced.
 *
 * @module @xiaob/dsh-memory-tree/store
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
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
  run_id     TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nodes_dedupe
  ON nodes(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_nodes_active ON nodes(session_id, level, is_active);
CREATE INDEX IF NOT EXISTS ix_nodes_parent ON nodes(session_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_nodes_roots
  ON nodes(session_id, is_active, parent_id, msg_start);
CREATE TABLE IF NOT EXISTS runs (
  run_id     TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  committed  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS keeps (
  session_id TEXT NOT NULL,
  checkpoint INTEGER NOT NULL,
  keys       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session_id, checkpoint)
);
CREATE TABLE IF NOT EXISTS session_prefs (
  session_id TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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

/** Run one synchronous multi-statement write as an all-or-nothing transaction. */
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The failed statement already rolled the transaction back.
    }
    throw error
  }
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
    db.exec('CREATE INDEX IF NOT EXISTS ix_nodes_run ON nodes(run_id)')
    this.#db = db
    this.#recoverRuns(db)
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
    for (const [column, type] of [
      ['meta', 'TEXT'], ['time_start', 'TEXT'], ['time_end', 'TEXT'], ['run_id', 'TEXT'],
    ]) {
      if (!existing.has(column)) db.exec(`ALTER TABLE nodes ADD COLUMN ${column} ${type}`)
    }
  }

  /**
   * Remove nodes written by a background run whose checkpoint never landed.
   *
   * Node rows are written before the session checkpoint (the checkpoint has to
   * reference them), so a hard restart can leave complete orphans behind. Their
   * run row is still `committed = 0`; the next open deletes those nodes. The
   * session log is untouched, so the current context is unaffected.
   * @param {import('node:sqlite').DatabaseSync} db open handle.
   * @returns {void}
   */
  #recoverRuns(db) {
    const stale = db.prepare('SELECT run_id FROM runs WHERE committed = 0').all()
    if (stale.length === 0) return
    transaction(db, () => {
      const removeNodes = db.prepare('DELETE FROM nodes WHERE run_id = ?')
      const removeRun = db.prepare('DELETE FROM runs WHERE run_id = ?')
      for (const row of stale) {
        removeNodes.run(row['run_id'])
        removeRun.run(row['run_id'])
      }
    })
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

  /**
   * Reserve the next per-level node id. Callers that summarize chunks in reverse
   * order reserve ids in forward order so the serial still follows the timeline.
   * @param {string} sessionId owning session.
   * @param {number} [level] tree level, default 0.
   * @returns {string} reserved id.
   */
  nextNodeId(sessionId, level = 0) {
    return this.#nextId(sessionId, level)
  }

  /**
   * Open a durable run marker before a background pass writes nodes.
   * @param {string} sessionId owning session.
   * @returns {string} run id attached to every node the pass writes.
   */
  beginRun(sessionId) {
    const runId = randomUUID()
    this.#open()
      .prepare('INSERT INTO runs (run_id, session_id, committed) VALUES (?, ?, 0)')
      .run(runId, sessionId)
    return runId
  }

  /**
   * Mark a run's nodes as covered by a checkpoint.
   * @param {string} runId run returned by {@link beginRun}.
   * @returns {void}
   */
  commitRun(runId) {
    this.#open()
      .prepare('UPDATE runs SET committed = 1 WHERE run_id = ?')
      .run(runId)
  }

  /**
   * Delete a failed or cancelled run's nodes and its marker.
   * @param {string} runId run returned by {@link beginRun}.
   * @returns {void}
   */
  discardRun(runId) {
    if (typeof runId !== 'string' || runId === '') return
    const db = this.#open()
    transaction(db, () => {
      db.prepare('DELETE FROM nodes WHERE run_id = ?').run(runId)
      db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId)
    })
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
   * @param {string} [leaf.id] reserved id; defaults to the next per-level id.
   * @param {number} [leaf.msgStart] explicit first message ordinal; defaults to the next free ordinal.
   * @param {number} [leaf.msgEnd] explicit last message ordinal; defaults to `msgStart + count - 1`.
   * @param {string} [leaf.dedupeKey] content hash, unique per session.
   * @param {[string, string] | null} [leaf.timeRange] start/end timestamps.
   * @param {string} [leaf.runId] background run marker.
   * @returns {string} the new id.
   */
  addLeaf({
    id: reservedId, sessionId, summary, details, meta, count, msgStart, msgEnd, dedupeKey, timeRange, runId,
  }) {
    const id = typeof reservedId === 'string' && reservedId !== ''
      ? reservedId
      : this.#nextId(sessionId, 0)
    const start = Number.isSafeInteger(msgStart) ? msgStart : this.#nextOrdinal(sessionId)
    const end = Number.isSafeInteger(msgEnd) ? msgEnd : start + Math.max(0, count - 1)
    const [timeStart, timeEnd] = Array.isArray(timeRange) ? timeRange : [null, null]
    this.#open()
      .prepare(`INSERT INTO nodes
        (session_id, id, level, summary, msg_start, msg_end, dedupe_key, details, meta, time_start, time_end, run_id)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, id, summary, start, end,
        dedupeKey ?? null, JSON.stringify(details ?? []), JSON.stringify(meta ?? {}),
        timeStart, timeEnd, runId ?? null)
    return id
  }

  /**
   * Merge several nodes into one new parent and deactivate the children.
   * @param {object} merge
   * @param {string} merge.sessionId owning session.
   * @param {string[]} merge.childIds nodes to merge, oldest first.
   * @param {string} merge.summary the parent's text.
   * @param {object} [merge.meta] parent `{schema_version, fields}` payload.
   * @param {string} [merge.runId] background run marker.
   * @returns {string} the parent id.
   */
  merge({ sessionId, childIds, summary, meta, runId }) {
    if (childIds.length === 0) throw new Error('merge: childIds must not be empty')
    const db = this.#open()
    return transaction(db, () => {
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
        (session_id, id, level, summary, msg_start, msg_end, meta, time_start, time_end, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sessionId, parentId, level, summary, start, end,
          JSON.stringify(meta ?? {}), starts[0] ?? null, ends[ends.length - 1] ?? null, runId ?? null)
      const detach = db.prepare('UPDATE nodes SET parent_id = ?, is_active = 0 WHERE session_id = ? AND id = ?')
      for (const childId of childIds) detach.run(parentId, sessionId, childId)
      return parentId
    })
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
    transaction(db, () => {
      db.prepare(`UPDATE nodes SET parent_id = NULL, is_active = 1
                  WHERE session_id = ? AND parent_id IN (${marks})`)
        .run(sessionId, ...ids)
      db.prepare(`DELETE FROM nodes WHERE session_id = ? AND id IN (${marks})`)
        .run(sessionId, ...ids)
    })
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

  /**
   * Whether one session opted into memory-tree compaction. Unknown sessions
   * default to disabled, so new conversations and conversations opened before
   * the plugin was installed stay on the framework's ordinary compaction until
   * the user turns the switch on.
   * @param {string} sessionId owning session.
   * @returns {boolean} true only after this session explicitly opted in.
   */
  sessionEnabled(sessionId) {
    const row = this.#open()
      .prepare('SELECT enabled FROM session_prefs WHERE session_id = ?')
      .get(sessionId)
    return row !== undefined && Number(row['enabled']) === 1
  }

  /**
   * Persist one session's memory-tree switch.
   * @param {string} sessionId owning session.
   * @param {boolean} enabled whether this session uses the memory tree.
   * @returns {void}
   */
  setSessionEnabled(sessionId, enabled) {
    this.#open()
      .prepare(`INSERT INTO session_prefs (session_id, enabled, updated_at)
                VALUES (?, ?, unixepoch())
                ON CONFLICT(session_id) DO UPDATE SET
                  enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(sessionId, enabled ? 1 : 0)
  }

  /**
   * Move one session's whole memory tree to another session id.
   *
   * Used by Planner's consciousness transfer: the old body has been seeded into
   * the new Session, so the message ranges still line up. The old session loses
   * its tree; the new one becomes the single active owner. Refuses to overwrite
   * a target that already has nodes.
   * @param {string} sourceId old session.
   * @param {string} targetId new session.
   * @returns {{nodes: number, keeps: number, enabled: boolean}} moved counts.
   */
  moveSession(sourceId, targetId) {
    if (sourceId === targetId) throw new Error('source and target sessions are identical')
    const db = this.#open()
    return transaction(db, () => {
      const targetCount = Number(db.prepare(
        'SELECT COUNT(*) AS n FROM nodes WHERE session_id = ?',
      ).get(targetId)?.['n'] ?? 0)
      if (targetCount > 0) throw new Error('target session already has a memory tree')
      const sourceNodes = Number(db.prepare(
        'SELECT COUNT(*) AS n FROM nodes WHERE session_id = ?',
      ).get(sourceId)?.['n'] ?? 0)
      const sourceKeeps = Number(db.prepare(
        'SELECT COUNT(*) AS n FROM keeps WHERE session_id = ?',
      ).get(sourceId)?.['n'] ?? 0)
      const enabled = this.sessionEnabled(sourceId)
      db.prepare('UPDATE nodes SET session_id = ? WHERE session_id = ?').run(targetId, sourceId)
      db.prepare('UPDATE keeps SET session_id = ? WHERE session_id = ?').run(targetId, sourceId)
      db.prepare('UPDATE runs SET session_id = ? WHERE session_id = ?').run(targetId, sourceId)
      db.prepare('DELETE FROM session_prefs WHERE session_id = ?').run(targetId)
      db.prepare(`INSERT INTO session_prefs (session_id, enabled, updated_at)
                  VALUES (?, ?, unixepoch())`).run(targetId, enabled ? 1 : 0)
      db.prepare('DELETE FROM session_prefs WHERE session_id = ?').run(sourceId)
      this.#counters.delete(sourceId)
      this.#counters.delete(targetId)
      return { nodes: sourceNodes, keeps: sourceKeeps, enabled }
    })
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
