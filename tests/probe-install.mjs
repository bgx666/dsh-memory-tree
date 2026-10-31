#!/usr/bin/env node
/**
 * Check the profile copy byte-for-byte and the database schema it will open.
 * This is the offline answer to "did my edit actually reach the running plugin?"
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const profile = process.env['DSH_PROFILE_DIR']
  ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'profiles', 'desktop')
const target = join(profile, 'node_modules', '@xiaob', 'dsh-memory-tree')
const files = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg',
  'src/text.js', 'src/engine.js', 'src/store.js', 'src/tool.js',
  'prompts/compress/leaf_zh.md']

let failed = 0
for (const file of files) {
  const source = join(root, file)
  const installed = join(target, file)
  if (!existsSync(source)) {
    console.error(`missing source: ${file}`)
    failed += 1
    continue
  }
  if (!existsSync(installed)) {
    console.error(`missing installed copy: ${file}`)
    failed += 1
    continue
  }
  if (!readFileSync(source).equals(readFileSync(installed))) {
    console.error(`drift: ${file}`)
    failed += 1
  }
}

const client = readFileSync(join(target, 'client.js'), 'utf8')
for (const [label, needle] of [
  ['slot takeover', "key: 'compaction'"],
  ['shadowing priority', 'priority: -1'],
  ['pluggable build stamp', 'const BUILD ='],
]) {
  if (!client.includes(needle)) {
    console.error(`client.js lacks ${label}`)
    failed += 1
  }
}

const dbPath = process.env['DSH_MEMORY_TREE_DB']
  ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'memory-tree', 'memory_tree.db')
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const columns = new Set(db.prepare('PRAGMA table_info(nodes)').all().map(row => String(row.name)))
  db.close()
  for (const column of ['meta', 'time_start', 'time_end', 'details', 'dedupe_key']) {
    if (!columns.has(column)) {
      console.error(`database lacks column: ${column}`)
      failed += 1
    }
  }
  console.log(`database ok: ${dbPath}`)
} else {
  console.log(`database not created yet: ${dbPath}`)
}

if (failed > 0) {
  console.error(`\nprobe failed: ${failed} issue(s)`)
  process.exit(1)
}
console.log('probe passed: installed copy matches the checkout')
