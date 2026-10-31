/**
 * Offline regression for the async compaction policy: pricing, span selection,
 * transcript replay, and the idle-lock scan. These helpers carry no Harness
 * dependency, so they run in a plain Node process.
 */

import assert from 'node:assert/strict'
import {
  buildInput,
  frameBlocks,
  inspectIdle,
  resolveSpec,
  selectRange,
  sameSeqs,
} from '../src/policy.js'

const config = {
  thresholdRatio: 0.5,
  headroomTokens: 0,
  retainRatio: 0.1,
  modelPolicies: [],
}
const header = { config: { provider: 'p', model: 'm', maxTokens: 0 } }
const info = { context: { contextWindow: 1000 }, defaultMaxTokens: 0 }

assert.deepEqual(resolveSpec(config, header, info), { thresholdTokens: 500, retainMessages: 0 })
assert.deepEqual(resolveSpec(config, header, info, { triggerTokens: 200, retainMessages: 50 }), {
  thresholdTokens: 200, retainMessages: 50,
})
assert.deepEqual(resolveSpec(config, header, info, {}, { contextWindow: 2000 }), {
  thresholdTokens: 1000, retainMessages: 0,
})
assert.equal(resolveSpec(config, header, { defaultMaxTokens: 0 }), null)

const events = new Map()
for (let seq = 1; seq <= 10; seq += 1) {
  events.set(seq, {
    type: seq === 1 ? 'system/message' : 'user/message',
    seq,
    data: { message: { role: seq === 1 ? 'system' : 'user', content: [{ type: 'text', text: `m${seq}` }] } },
  })
}
const session = {
  surface: { nodes: [...events.keys()] },
  eventAt: seq => events.get(seq),
  deriveEventMessage: event => event.data.message,
  requestHeader: () => ({ tools: [{ name: 'read' }] }),
  seq: 11,
}
const measurement = { nodes: [...events.keys()].map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })) }

assert.deepEqual(selectRange(session, measurement, 2, () => true), {
  start: 2, end: 8, startIdx: 1, endIdx: 7,
})
const trimmed = selectRange(session, measurement, 2, (s, seq) => seq !== 9)
assert.equal(trimmed.end, 7)
assert.equal(selectRange(session, measurement, 9, () => true), null)

assert.deepEqual(buildInput(session, [2, 3]).messages.map(message => message.content[0].text), ['m1', 'm2', 'm3'])
assert.deepEqual(buildInput(session, [2]).tools, [{ name: 'read' }])

const idleEvents = new Map()
idleEvents.set(1, { type: 'turn/start', seq: 1, data: { turn: 1 } })
idleEvents.set(2, { type: 'turn/end', seq: 2, data: { turn: 1 } })
idleEvents.set(3, { type: 'compaction/start', seq: 3, data: {} })
idleEvents.set(4, { type: 'compaction/end', seq: 4, data: {} })
const idleSession = { seq: 5, eventAt: seq => idleEvents.get(seq) }
assert.deepEqual(inspectIdle(idleSession), { openTurn: null, unmatched: undefined })

idleEvents.set(5, { type: 'compaction/start', seq: 5, data: {} })
const locked = { seq: 6, eventAt: seq => idleEvents.get(seq) }
assert.ok(inspectIdle(locked).unmatched !== undefined)

const blocks = frameBlocks(['[记忆树] 一段'])
assert.match(blocks[0].text, /automatically generated checkpoint/)
assert.equal(blocks[0].text.endsWith('<compacted-summary>'), true)
assert.equal(blocks.at(-1).text, '</compacted-summary>')
assert.equal(sameSeqs([1, 2], [1, 2]), true)
assert.equal(sameSeqs([1, 2], [1, 3]), false)

console.log('policy tests passed')
