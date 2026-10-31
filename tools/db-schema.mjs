#!/usr/bin/env node
/**
 * Print the SQLite schema of the memory tree, so a migration can be checked
 * without opening the database in a GUI.
 */

import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../src/store.js'

const path = process.env['DSH_MEMORY_TREE_DB'] ?? defaultDbPath()
const db = new DatabaseSync(path)
console.log(`database ${path}\n`)
for (const table of ['nodes']) {
  console.log(`[${table}]`)
  for (const column of db.prepare(`PRAGMA table_info(${table})`).all()) {
    console.log(`  ${column.name.padEnd(12)} ${column.type}${column.notnull ? ' NOT NULL' : ''}${column.pk ? ' PK' : ''}`)
  }
}
for (const index of db.prepare("PRAGMA index_list('nodes')").all()) {
  console.log(`  index ${index.name}${index.unique ? ' UNIQUE' : ''}`)
}
db.close()
