/**
 * Client-half regression: evaluate `client.js` exactly the way the page's
 * module loader does, then assert the slot takeover and the checkpoint parser.
 * No browser and no React runtime: only the registration contract is checked.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value },
  },
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useMemo: factory => factory(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: initial => ({ current: initial }),
  useEffect: () => {},
}

// The loader evaluates a factory with the app's own `require`.
new Function('window', source)(globalThis.window)
assert.equal(definition.id, '@xiaob/dsh-memory-tree')

const module = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
assert.equal(typeof module.apply, 'function')
assert.deepEqual(module.inject, ['slots'])
assert.equal(typeof module.__parseSummary, 'function')

let registration
let settingsRegistration
let statusRegistration
const scope = {
  getSnapshot: () => ({
    status: 'ready',
    value: { chunkTokens: 30000, language: 'zh', async: true },
    user: {},
    writable: true,
    revision: 1,
  }),
  subscribe: () => () => {},
  mutate: async () => true,
  unset: async () => true,
}
const ctx = {
  get(name) {
    return name === 'configForms' ? { get: () => scope } : undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, callback) {
      assert.ok(name === 'conversation.chat.node'
        || name === 'settings.section'
        || name === 'conversation.composer.dock')
      return callback()
    },
    register(options, component) {
      if (options.name === 'settings.section') settingsRegistration = { options, component }
      else if (options.name === 'conversation.composer.dock') statusRegistration = { options, component }
      else registration = { options, component }
      return () => {}
    },
    entriesOfSlot() { return [] },
  },
}
module.apply(ctx)
assert.equal(registration.options.name, 'conversation.chat.node')
assert.equal(registration.options.key, 'compaction')
assert.equal(registration.options.priority, -1)
assert.equal(typeof registration.component, 'function')
assert.equal(registration.component.name, 'MemoryTreeCard')
assert.equal(settingsRegistration.options.name, 'settings.section')
assert.equal(settingsRegistration.options.id, 'memory-tree')
assert.equal(settingsRegistration.options.label, '记忆树')
assert.equal(settingsRegistration.component.name, 'MemoryTreeSettings')
assert.equal(statusRegistration.options.name, 'conversation.composer.dock')
assert.equal(statusRegistration.options.id, 'memory-tree-status')
assert.equal(statusRegistration.component.name, 'MemoryTreeStatus')

const sample = [
  '[记忆树] 共 2 个活跃节点，深度 L1，已折叠到第 40 条。',
  '[node1_001 · L1 · 第1-40条] [已压缩 · 不需要压缩]',
  '[摘要] 合并后的父节点',
  '[任务] 目标：接进 DSH；状态：验证',
  '[node0_004 · L0 · 第31-40条] [已压缩 · 不需要压缩]',
  '[摘要] 最近一段叶子',
  '[时间] 2026-10-31 20:00 ~ 20:10',
  '[决策] 复用事务（因为不用重写锁）',
].join('\n')
const parsed = module.__parseSummary(sample)
assert.match(parsed.header, /共 2 个活跃节点/)
assert.equal(parsed.nodes.length, 2)
assert.equal(parsed.nodes[0].id, 'node1_001')
assert.equal(parsed.nodes[0].level, 1)
assert.equal(parsed.nodes[0].summary, '合并后的父节点')
assert.equal(parsed.nodes[1].id, 'node0_004')
assert.equal(parsed.nodes[1].time, '2026-10-31 20:00 ~ 20:10')
assert.ok(parsed.nodes[1].body.some(line => line.startsWith('[决策]')))

const fallback = module.__parseSummary('<compacted-summary>\n不是记忆树写的摘要\n</compacted-summary>')
assert.equal(fallback.nodes.length, 0)
assert.match(fallback.raw, /不是记忆树写的摘要/)

// Older checkpoints were joined without separators: the first node header can
// sit on the same line as the digest header. The card must still split it.
const joined = module.__parseSummary(
  '[记忆树] 共 2 个活跃节点，已折叠到第 8 条。下面每段是一个节点。[node0_001 · L0 · 第1-4条] [已压缩 · 不需要压缩]\n'
  + '[摘要] 第一段\n[node0_002 · L0 · 第5-8条] [已压缩 · 不需要压缩]\n[摘要] 第二段',
)
assert.equal(joined.nodes.length, 2)
assert.equal(joined.nodes[0].id, 'node0_001')
assert.equal(joined.nodes[1].summary, '第二段')

// The slot renderer wraps the card in `[data-slot]`; folding must climb to the
// owning `.flowItem` row, not hide the wrapper's (empty) siblings.
function fakeRow(name, isCard = false) {
  return {
    name,
    style: { display: '' },
    parentElement: null,
    previousElementSibling: null,
    hasAttribute(attr) {
      if (attr === 'data-chat-node-key') return true
      if (attr === 'data-memtree-card') return isCard
      return false
    },
    querySelector(selector) {
      return selector === '[data-memtree-card]' && isCard ? {} : null
    },
  }
}
const container = {}
const rows = [fakeRow('r1'), fakeRow('r2'), fakeRow('r3'), fakeRow('card')]
for (const [index, row] of rows.entries()) {
  row.parentElement = container
  row.previousElementSibling = rows[index - 1] ?? null
}
const anchor = { parentElement: rows[3], previousElementSibling: null }
assert.equal(module.__foldSiblings(anchor, true), 3)
assert.equal(rows[0].style.display, 'none')
assert.equal(rows[1].style.display, 'none')
assert.equal(rows[2].style.display, 'none')
assert.equal(rows[3].style.display, '')
assert.equal(module.__foldSiblings(anchor, false), 3)
assert.equal(rows[0].style.display, '')

// Retained rows are found by their real Chat keys. The fold starts before the
// oldest retained row; it is not a fixed count.
function fakeKeyRow(name, key) {
  return {
    name,
    style: { display: '' },
    parentElement: null,
    hasAttribute: attr => attr === 'data-chat-node-key',
    getAttribute: attr => attr === 'data-chat-node-key' ? key : null,
    contains() { return false },
    querySelector() { return null },
  }
}
const keyContainer = {
  querySelectorAll: () => keyRows,
}
const keyRows = [
  fakeKeyRow('old-1', '13:input-messageold'),
  fakeKeyRow('old-2', '9:tool-callold'),
  fakeKeyRow('kept-1', '13:input-messagekept'),
  fakeKeyRow('kept-2', '14:assistant-step7:2'),
  fakeKeyRow('card', '10:compactionc'),
]
for (const [index, row] of keyRows.entries()) {
  row.parentElement = keyContainer
  row.previousElementSibling = keyRows[index - 1] ?? null
}
const keyAnchor = { parentElement: keyRows[4], previousElementSibling: null }
assert.equal(module.__foldBeforeKeys(keyAnchor, ['13:input-messagekept', '14:assistant-step7:2']), 2)
assert.equal(keyRows[0].style.display, 'none')
assert.equal(keyRows[1].style.display, 'none')
assert.equal(keyRows[2].style.display, '')
assert.equal(keyRows[3].style.display, '')
module.__foldSiblings(keyAnchor, false)

const earlierCard = [fakeRow('r1'), fakeRow('older-card', true), fakeRow('r3'), fakeRow('card')]
for (const [index, row] of earlierCard.entries()) {
  row.parentElement = container
  row.previousElementSibling = earlierCard[index - 1] ?? null
}
const secondAnchor = { parentElement: earlierCard[3], previousElementSibling: null }
assert.equal(module.__foldSiblings(secondAnchor, true), 3)
assert.equal(earlierCard[0].style.display, 'none')
assert.equal(earlierCard[1].style.display, 'none')
assert.equal(earlierCard[2].style.display, 'none')
module.__foldSiblings(secondAnchor, false)

console.log('client tests passed')
