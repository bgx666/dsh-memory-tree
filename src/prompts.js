/**
 * Compression prompt templates shipped with the plugin.
 *
 * Rendering raises when a template references a placeholder the caller did not
 * supply; that strictness keeps a missing budget line from silently shipping to
 * the model.
 *
 * @module @xiaob/dsh-memory-tree/prompts
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

/** @type {Map<string, string>} */
const cache = new Map()

/**
 * Read one template as-is.
 * @param {string} name path under `prompts/` without the `.md` suffix, e.g. `compress/leaf_zh`.
 * @returns {string} template text, cached for the process lifetime.
 */
export function load(name, override) {
  if (typeof override === 'string' && override !== '') return override
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  const text = readFileSync(join(ROOT, `${name}.md`), 'utf8')
  cache.set(name, text)
  return text
}

/**
 * Substitute `{placeholder}` occurrences.
 * @param {string} name template path.
 * @param {Record<string, unknown>} vars values keyed by placeholder name.
 * @param {string} [override] custom template from settings, when present.
 * @returns {string} rendered text.
 * @throws {Error} when the template references a placeholder absent from `vars`.
 */
export function render(name, vars = {}, override) {
  const template = load(name, override)
  return template.replace(/\{([a-z_]+)\}/g, (match, key) => {
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`prompt ${name}: missing placeholder ${match}`)
    }
    return String(vars[key])
  })
}
