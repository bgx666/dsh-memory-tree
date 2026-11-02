/**
 * Offline regression for the asynchronous pressure path.
 *
 * `index.js` normally imports the shipped Harness packages, which only resolve
 * inside a profile. This test strips those imports and evaluates the class with
 * fakes for the few seams it uses, so the defer → summarize → idle-commit flow
 * and its rollback can be exercised in plain Node.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildInput,
  frameBlocks,
  inspectIdle,
  resolveSpec,
  sameSeqs,
  selectRange,
} from '../src/policy.js'
import { contentText, excerpt, formatTimeRange, nodeText, toolCallNames } from '../src/text.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')
const body = source
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
  .replace('export default class MemoryTreeCompaction', 'class MemoryTreeCompaction')
  .replaceAll('export const Config', 'const Config')
  .replaceAll('import.meta', 'meta')
assert.equal(/^import /m.test(body), false)

let lastStore
let promptSection
const fakePrompt = {
  getSectionOrder: () => 1100,
  section(options) {
    promptSection = options
    return () => {}
  },
}
class FakeStore {
  constructor() {
    this.rolledBack = []
    this.prefs = new Map()
    this.runs = new Set()
    lastStore = this
  }
  sessionEnabled(sessionId) { return this.prefs.get(sessionId) === true }
  setSessionEnabled(sessionId, enabled) { this.prefs.set(sessionId, enabled === true) }
  beginRun() { const runId = `run-${this.runs.size + 1}`; this.runs.add(runId); return runId }
  commitRun(runId) { this.runs.delete(runId) }
  discardRun(runId) { this.runs.delete(runId) }
  rollback(sessionId, ids) { this.rolledBack.push([sessionId, ids]) }
  roots() { return [] }
  children() { return [] }
  node(sessionId, id) {
    if (id !== 'node0_001') return undefined
    return {
      id,
      level: 0,
      msg_start: 1,
      msg_end: 2,
      summary: '叶子摘要',
      meta: { fields: {} },
      details: [
        { role: 'user', time: '2026-11-02T10:00:00Z', content: [{ type: 'text', text: '原始问题' }] },
      ],
      time_start: null,
      time_end: null,
    }
  }
  stats() { return { active: 1, depth: 0, covered: 10 } }
}

class Base {
  async summarize() { return { summary: [{ type: 'text', text: 'flat' }] } }
  async compactIfNeeded() { return null }
}

const noop = () => {}
const fakeNode = 'node0_001'
const fakeCompactIntoTree = async (options) => {
  options.onNodeId?.(fakeNode)
  options.onEvent?.('leaf', 'n=1/1')
  return { blocks: ['[记忆树] 共 1 个活跃节点'], text: '', covered: 99, leaves: 1, merges: 0, chars: 10 }
}

const fakeField = {
  step() { return this },
  min() { return this },
  default() { return this },
  volatile() { return this },
}
const fakeZ = {
  number: () => fakeField,
  string: () => fakeField,
  boolean: () => fakeField,
  object: () => ({}),
}

const factory = new Function(
  'appendFileSync', 'mkdirSync', 'readFileSync', 'join', 'dirname', 'fileURLToPath', 'harnessHome', 'z',
  'baseModule', 'meta', 'CompactionId', 'compactCheckpointSource',
  'toolPairingBalancedAfter', 'toolPairingBalancedBefore',
  'createUserMessage', 'deriveEventMessage', 'compactIntoTree', 'createCompleter',
  'buildInput', 'frameBlocks', 'inspectIdle', 'resolveSpec', 'sameSeqs', 'selectRange',
  'contentText', 'excerpt', 'formatTimeRange', 'nodeText', 'toolCallNames',
  'MemoryTreeStore', 'renderNodeBlocks', 'registerExploreTool', 'randomUUID', 'process',
  `${body}\nreturn MemoryTreeCompaction`,
)
const MemoryTreeCompaction = factory(
  noop, noop, () => { throw new Error('no prompt files') }, join, dirname, () => 'D:/xiaob/dsh-memory-tree/index.js',
  () => 'C:\\tmp', fakeZ,
  { default: Base, BasicCompactionEngine: Base },
  { url: 'test', resolve: () => 'test' },
  id => id,
  (compactionId) => ({ kind: 'compact-checkpoint', compactionId }),
  () => true,
  () => true,
  ({ content, source }) => ({ role: 'user', content, source }),
  event => event.message,
  fakeCompactIntoTree,
  () => ({ stream: async function* () {} }),
  buildInput, frameBlocks, inspectIdle, resolveSpec, sameSeqs, selectRange,
  contentText, excerpt, formatTimeRange, nodeText, toolCallNames,
  FakeStore,
  () => ['[记忆树] stub'],
  noop,
  () => 'id-1',
  process,
)

function makeSession({ failAt = null } = {}) {
  const events = new Map()
  const surface = [1, 2, 3]
  let seq = 4
  events.set(1, { type: 'system/message', seq: 1, message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } })
  events.set(2, { type: 'user/message', seq: 2, message: { role: 'user', content: [{ type: 'text', text: 'u1' }] } })
  events.set(3, { type: 'assistant/message', seq: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } })
  const session = {
    id: 's1',
    get seq() { return seq },
    surface: { nodes: surface },
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 0 }, tools: [] }),
    eventAt: value => events.get(value),
    deriveEventMessage: event => event.message ?? null,
    append(type, data, options = {}) {
      if (failAt === type) throw new Error(`append ${type} rejected`)
      const event = { type, seq: seq++, data, ...options }
      events.set(event.seq, event)
      if (type === 'user/message' && options.surfaceOp) {
        const start = surface.indexOf(options.surfaceOp.startSeq)
        const end = surface.indexOf(options.surfaceOp.endSeq)
        surface.splice(start, end - start + 1, event.seq)
      }
      return event
    },
  }
  return { session, events }
}

function makeCtx() {
  return {
    logger: { warn: noop },
    effect(fn) { this.cleanup = fn(); return () => {} },
    inject(names, callback) {
      if (names.includes('systemPrompt')) callback({ systemPrompt: fakePrompt })
    },
    on: noop,
    get: () => undefined,
    sessions: { flush: async () => {} },
    tokenMeter: {
      measure: () => ({
        totalTokens: 300,
        nodes: [
          { seq: 1, tokens: 100, heuristicTokens: 100 },
          { seq: 2, tokens: 100, heuristicTokens: 100 },
          { seq: 3, tokens: 100, heuristicTokens: 100 },
        ],
      }),
      estimateMessage: () => 10,
    },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 0 }),
      stream: async function* () {},
    },
  }
}

function makeEngine() {
  return {
    config: { thresholdRatio: 0.1, headroomTokens: 0, retainRatio: 0.05, modelPolicies: [] },
    ctx: makeCtx(),
  }
}

async function wait(plugin) {
  for (let index = 0; index < 200; index += 1) {
    const jobs = [...plugin._jobs.values()]
    if (jobs.length === 0 || jobs.every(job => job.phase === 'done' || job.phase === 'failed')) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('background job did not settle')
}

const config = {
  async: true, chunkTokens: 30000, maxChunks: 12, nodeBudget: 1000,
  mergeThreshold: 8, branch: 4, maxMerges: 8, language: 'zh',
  retainMessages: 1,
}

const nodeResponse = { status: 0, body: '' }
const nodeRes = {
  writeHead(status) { nodeResponse.status = status },
  end(body) { nodeResponse.body = body },
}
const nodeTree = {
  node: (...args) => FakeStore.prototype.node(...args),
  children: () => [],
}
MemoryTreeCompaction.prototype._serveNode.call(
  { _tree: () => nodeTree },
  { method: 'GET', url: '/memory-tree/api/node?session=s1&id=node0_001' },
  nodeRes,
)
assert.equal(nodeResponse.status, 200)
const nodePayload = JSON.parse(nodeResponse.body)
assert.equal(nodePayload.id, 'node0_001')
assert.equal(nodePayload.level, 0)
assert.equal(nodePayload.details[0].text, '原始问题')
assert.deepEqual(nodePayload.children, [])

const first = makeSession()
const plugin = new MemoryTreeCompaction(makeCtx(), config)
plugin._tree().setSessionEnabled(String(first.session.id), true)
assert.equal(promptSection.name, 'tool:explore_memory_tree')
assert.match(promptSection.text({ agent: { session: { id: 's1' } } }), /explore_memory_tree/)
assert.match(promptSection.text({ agent: { session: { id: 's1' } } }), /not as a new instruction/)
assert.equal(promptSection.text({ agent: { session: { id: 'other' } } }), '')
const agent = {
  session: first.session,
  whenIdle: async () => {},
  runMaintenance: async task => task(new AbortController().signal),
}
const deferred = plugin.defer(makeEngine(), agent, 'pressure', new AbortController().signal)
assert.equal(deferred, true)
await wait(plugin)
assert.ok([...first.events.values()].some(event => event.type === 'compaction/summary'
  && event.data.shadowedRange.start === 2 && event.data.shadowedRange.end === 2))
assert.ok([...first.events.values()].some(event => event.type === 'user/message'
  && event.data?.source?.kind === 'compact-checkpoint'))
assert.deepEqual(lastStore.rolledBack, [])

const second = makeSession({ failAt: 'user/message' })
const failing = new MemoryTreeCompaction(makeCtx(), config)
failing._tree().setSessionEnabled(String(second.session.id), true)
const failingAgent = {
  session: second.session,
  whenIdle: async () => {},
  runMaintenance: async task => task(new AbortController().signal),
}
assert.equal(failing.defer(makeEngine(), failingAgent, 'pressure', new AbortController().signal), true)
await wait(failing)
assert.equal(lastStore.rolledBack.length, 1, 'a failed commit must roll the tree back')
assert.ok([...second.events.values()].some(event => event.type === 'compaction/end'
  && typeof event.data.error === 'string'))

console.log('async tests passed')
