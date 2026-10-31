#!/usr/bin/env node
/**
 * `memory-tree status` — the human-facing answer to "这是个节点吗？"
 *
 * The provider is deliberately quiet: it writes rows and returns a digest, and
 * the only trace in the chat is one collapsed line. That makes it impossible to
 * tell from the UI whether a summary really became a node, so this command reads
 * the same database and prints the tree, plus the tail of the lifecycle log.
 *
 * Usage:
 *   node src/status.js                  # every session, active roots only
 *   node src/status.js <session-id>     # one session, full tree with children
 *   node src/status.js --db <path>      # alternate database file
 *   node src/status.js --json           # machine-readable
 *   node src/status.js --log 20         # how many log lines to show (0 = none)
 *
 * @module @xiaob/dsh-memory-tree/status
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath, harnessHome } from './store.js'
import { excerpt, stamp } from './text.js'

const COLUMNS = 'id, level, summary, parent_id, msg_start, msg_end, created_at, is_active'
const EXCERPT_CHARS = 80
const MAX_DEPTH = 6

/** Minimal flag parsing; the command has no dependencies by design. */
function parseArgs(argv) {
  const options = { db: undefined, session: undefined, json: false, log: 6, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--db') options.db = argv[++index]
    else if (arg === '--log') options.log = Number.parseInt(argv[++index] ?? '', 10) || 0
    else if (!arg.startsWith('-')) options.session = arg
  }
  return options
}

/** Read-only open, falling back for Node builds without the option. */
function openDatabase(path) {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return new DatabaseSync(path)
  }
}

/** One session's summary row, or undefined. */
function sessionRow(db, sessionId) {
  return db.prepare(`SELECT session_id, COUNT(*) AS total,
                            SUM(is_active) AS active,
                            MAX(level) AS depth,
                            MAX(msg_end) AS covered,
                            MAX(created_at) AS last_at
                     FROM nodes WHERE session_id = ?
                     GROUP BY session_id`).get(sessionId)
}

/** Every session that owns at least one node, newest first. */
function allSessions(db) {
  return db.prepare(`SELECT session_id, COUNT(*) AS total,
                            SUM(is_active) AS active,
                            MAX(level) AS depth,
                            MAX(msg_end) AS covered,
                            MAX(created_at) AS last_at
                     FROM nodes GROUP BY session_id ORDER BY last_at DESC`).all()
}

/** `id L1 #3–#9 2026-10-30 13:02 · excerpt` */
function describeRow(row, inactive) {
  const parts = [
    String(row['id']),
    `L${row['level']}`,
    `#${row['msg_start']}–#${row['msg_end']}`,
    stamp(row['created_at']),
    excerpt(row['summary'], EXCERPT_CHARS),
  ]
  const suffix = inactive ? '   （已并入父节点）' : ''
  return `${parts.join('  ')}${suffix}`
}

/**
 * Render one session as an indented tree. Roots are drawn as siblings of a
 * virtual top node so every branch gets the same connector treatment.
 * @returns {string[]} one line per node.
 */
function renderTree(db, sessionId) {
  const byParent = db.prepare(`SELECT ${COLUMNS} FROM nodes
                               WHERE session_id = ? AND parent_id = ? ORDER BY msg_start, id`)
  const roots = db.prepare(`SELECT ${COLUMNS} FROM nodes
                            WHERE session_id = ? AND is_active = 1 AND parent_id IS NULL
                            ORDER BY msg_start, id`).all(sessionId)
  const lines = []
  const walk = (row, prefix, isLast, depth) => {
    const connector = depth === 0 ? '' : `${isLast ? '└─ ' : '├─ '}`
    const flag = Number(row['is_active']) === 1 ? '' : '~'
    lines.push(`${prefix}${connector}${flag}${describeRow(row, Number(row['is_active']) !== 1)}`)
    if (depth >= MAX_DEPTH) return
    const children = byParent.all(sessionId, row['id'])
    const childPrefix = depth === 0 ? '  ' : `${prefix}${isLast ? '   ' : '│  '}`
    for (let index = 0; index < children.length; index += 1) {
      walk(children[index], childPrefix, index === children.length - 1, depth + 1)
    }
  }
  for (let index = 0; index < roots.length; index += 1) {
    walk(roots[index], '', index === roots.length - 1, 0)
  }
  return lines
}

/** Tail of the lifecycle log written by the provider. */
function readLog(lines) {
  if (lines <= 0) return []
  const path = join(harnessHome(), 'memory-tree', 'plugin.log')
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').trimEnd()
  return text === '' ? [] : text.split(/\r?\n/).slice(-lines)
}

/** Header line for one session. */
function sessionHead(row) {
  const depth = Number(row['depth'] ?? -1)
  return `会话 ${row['session_id']}`
    + `\n  节点 ${row['total']}（活跃 ${row['active']}）· 深度 L${Math.max(0, depth)}`
    + ` · 覆盖到第 ${row['covered']} 条 · 最后写入 ${stamp(row['last_at'])}`
}

const HELP = `用法：node src/status.js [session-id] [--db <path>] [--json] [--log <n>]

  不带参数            列出所有会话，以及每个会话的活跃顶层节点
  <session-id>        打印这个会话的完整树（含已合并的子节点）
  --db <path>         换一个数据库文件（默认 $DSH_HOME/memory-tree/memory_tree.db）
  --json              输出 JSON
  --log <n>           附带最后 n 行生命周期日志（0 关闭，默认 6）`

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return 0
  }
  const dbPath = options.db ?? defaultDbPath()

  if (!existsSync(dbPath)) {
    if (options.json) {
      console.log(JSON.stringify({ db: dbPath, exists: false, sessions: [], log: readLog(options.log) }, null, 2))
      return 0
    }
    console.log(`数据库还不存在：${dbPath}`)
    console.log('说明这个安装里还没有任何一次压缩落盘——不是坏了，是还没触发。')
    const log = readLog(options.log)
    if (log.length > 0) console.log(`\n生命周期日志（${join(harnessHome(), 'memory-tree', 'plugin.log')}）：\n${log.join('\n')}`)
    return 0
  }

  const db = openDatabase(dbPath)
  try {
    const sessions = options.session === undefined
      ? allSessions(db)
      : [sessionRow(db, options.session)].filter(row => row !== undefined)

    if (options.json) {
      const payload = {
        db: dbPath,
        exists: true,
        sessions: sessions.map(row => ({
          sessionId: row['session_id'],
          stats: {
            total: Number(row['total']),
            active: Number(row['active']),
            depth: Number(row['depth']),
            covered: Number(row['covered']),
          },
          nodes: db.prepare(`SELECT ${COLUMNS} FROM nodes WHERE session_id = ? ORDER BY level, msg_start, id`)
            .all(row['session_id'])
            .map(node => ({ ...node, is_active: Number(node['is_active']) === 1 })),
        })),
        log: readLog(options.log),
      }
      console.log(JSON.stringify(payload, null, 2))
      return 0
    }

    console.log(`数据库  ${dbPath}`)
    if (sessions.length === 0) {
      console.log(options.session === undefined
        ? '\n还没有任何节点。压缩还没有在这个安装里跑过。'
        : `\n会话 ${options.session} 里还没有节点。`)
      const log = readLog(options.log)
      if (log.length > 0) console.log(`\n生命周期日志：\n${log.join('\n')}`)
      return 0
    }
    for (const row of sessions) {
      console.log(`\n${sessionHead(row)}`)
      const tree = renderTree(db, row['session_id'])
      console.log(tree.length === 0 ? '  （没有活跃节点）' : tree.map(line => `  ${line}`).join('\n'))
    }
    const log = readLog(options.log)
    if (log.length > 0) {
      console.log(`\n生命周期日志（${join(harnessHome(), 'memory-tree', 'plugin.log')}）：`)
      console.log(log.map(line => `  ${line}`).join('\n'))
    }
    return 0
  } finally {
    db.close()
  }
}

process.exitCode = main()
