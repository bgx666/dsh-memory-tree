#!/usr/bin/env node
/**
 * Publish this checkout into the profile that actually loads it.
 *
 * DSH resolves the plugin by package name from the profile's `node_modules`, so
 * editing this directory alone changes nothing in the running app. The copy is
 * deliberately not a symlink: Node resolves a junction to its real path and then
 * looks for `@deepseek-ai/*` from `D:\xiaob`, where the harness packages do not
 * exist.
 *
 * Usage:
 *   node tools/sync.mjs            # copy over the installed profile copy
 *   node tools/sync.mjs --check    # compare only, exit 1 on drift
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageName = '@xiaob/dsh-memory-tree'
const profile = process.env['DSH_PROFILE_DIR']
  ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'profiles', 'desktop')

const target = join(profile, 'node_modules', ...packageName.split('/'))
const entries = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg',
  'README.md', 'locale', 'prompts', 'src']

/** Every regular file under one root, relative to it. */
function filesOf(base) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(base, path).replaceAll('\\', '/'))
    }
  }
  walk(base)
  return out.sort()
}

/** Compare source and target, returning the drifted paths. */
function drift() {
  if (!existsSync(target)) return ['(target missing)']
  const sourceFiles = entries.flatMap((entry) => {
    const path = join(root, entry)
    if (!existsSync(path)) return []
    return statSync(path).isDirectory()
      ? filesOf(path).map(file => `${entry}/${file}`)
      : [entry]
  })
  const changed = []
  for (const entry of sourceFiles) {
    const source = join(root, entry)
    const installed = join(target, entry)
    if (!existsSync(installed)) {
      changed.push(`${entry} (missing)`)
      continue
    }
    if (!readFileSync(source).equals(readFileSync(installed))) changed.push(entry)
  }
  for (const file of filesOf(target)) {
    if (!sourceFiles.includes(file)) changed.push(`${file} (stale)`)
  }
  return changed
}

if (process.argv.includes('--check')) {
  const changed = drift()
  if (changed.length === 0) {
    console.log(`in sync: ${target}`)
    process.exit(0)
  }
  console.error(`out of sync (${changed.length}):`)
  for (const entry of changed) console.error(`  ${entry}`)
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const entry of entries) {
  const source = join(root, entry)
  if (!existsSync(source)) continue
  cpSync(source, join(target, entry), { recursive: true })
}
console.log(`synced ${entries.length} entries -> ${target}`)
