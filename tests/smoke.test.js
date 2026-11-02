/**
 * Offline regression for the tree engine. No Harness, no model, no network:
 * `complete` is a stub, the store is a temp SQLite file, and every assertion is
 * about what the next compaction would hand back to the session.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactIntoTree } from '../src/engine.js'
import { splitByTokens } from '../src/chunk.js'
import { MemoryTreeStore } from '../src/store.js'
import { describe, registerExploreTool } from '../src/tool.js'
import { isCheckpoint, nodeText } from '../src/text.js'
import { DIGEST_MARK, renderNodeBlocks } from '../src/text.js'

const dir = mkdtempSync(join(tmpdir(), 'memtree-'))
const dbPath = join(dir, 'tree.db')
let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

function message(role, text, extra = {}) {
  return { role, content: [{ type: 'text', text }], ...extra }
}

function checkpoint(summary) {
  return {
    role: 'user',
    source: { kind: 'compact-checkpoint', compactionId: 'c1' },
    content: [{
      type: 'text',
      text: `This is an automatically generated checkpoint.\n\n<compacted-summary>\n${summary}\n</compacted-summary>`,
    }],
  }
}

function stubComplete(text = '这一段做了什么，进展到哪。') {
  return async () => ({
    text: JSON.stringify({
      summary: text,
      narration: '一句人话',
      task: { goal: '把记忆树接进 DSH', status: '正在验证', todo: ['跑测试'], next_steps: ['重启'], blockers: [] },
      decisions: [{ what: '复用 compaction-basic 的事务', why: '锁和 surface 替换不用重写' }],
      lessons: { errors: [{ symptom: '摘要重复', cause: 'kind 写成了 type', fix: '同时接受 kind/type' }], patterns: ['先看插件日志'] },
      context: { cwd: 'D:/xiaob', env: ['node 24'], commands: ['node tests/smoke.test.js'], artifacts: ['src/engine.js'], constraints: ['失败退回扁平摘要'] },
      user: ['偏好中文'],
    }),
  })
}

function freshMessages(count = 6) {
  const messages = [message('system', '你是小助。')]
  for (let index = 0; index < count; index += 1) {
    messages.push(message('user', `第 ${index + 1} 个问题：我们做到哪了？`))
    messages.push(message('assistant', `第 ${index + 1} 个回答：这是进展 ${index + 1}。`))
  }
  return messages
}

await test('checkpoint detection uses the source kind emitted by dsh-compaction', () => {
  assert.equal(isCheckpoint(checkpoint(`${DIGEST_MARK} 共 1 个节点`)), true)
  assert.equal(isCheckpoint({
    role: 'user',
    source: { kind: 'compact-checkpoint' },
    content: [{ type: 'text', text: 'old summary without a digest header' }],
  }), true)
  assert.equal(isCheckpoint({ role: 'user', content: [{ type: 'text', text: '普通用户消息' }] }), false)
})

await test('chunking never separates a tool call from its result', () => {
  const messages = [
    message('user', '跑一下测试'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'bash', arguments: '{}' }] },
    { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] },
    message('assistant', '测试通过'),
    message('user', '继续'),
  ]
  const chunks = splitByTokens(messages, 1, 12)
  for (const chunk of chunks) {
    if (chunk[0]?.role === 'tool') throw new Error('a chunk starts with an orphan tool result')
  }
  assert.ok(chunks.length >= 1)
})

await test('one fresh region becomes a level-0 leaf and a checkpoint digest', async () => {
  const store = new MemoryTreeStore(dbPath)
  const sessionId = 's-leaf'
  const result = await compactIntoTree({
    store,
    limits: { chunkTokens: 30000, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 8, branch: 4, maxMerges: 8 },
    input: { messages: freshMessages(4) },
    agent: { session: { id: sessionId } },
    complete: stubComplete(),
    sessionId,
    language: 'zh',
  })
  assert.equal(result.leaves, 1)
  const roots = store.roots(sessionId)
  assert.equal(roots.length, 1)
  assert.match(nodeText(roots[0]), /^\[node0_001 · L0 · 第1-8条\]/)
  assert.match(nodeText(roots[0]), /\[摘要\] 这一段做了什么/)
  assert.match(renderNodeBlocks({ roots, stats: store.stats(sessionId) })[0], /^\[记忆树\]/)
  store.close()
})

await test('configured prompt templates replace the shipped files', async () => {
  const store = new MemoryTreeStore(dbPath)
  const sessionId = 's-prompts'
  let instruction = ''
  const base = stubComplete()
  const complete = async (request) => {
    instruction = request.messages.at(-1).content[0].text
    return base(request)
  }
  await compactIntoTree({
    store,
    limits: {
      chunkTokens: 30000, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 8, branch: 4, maxMerges: 8,
      prompts: {
        zh: {
          leaf: 'CUSTOM-LEAF {scope}{cwd_line}{budget_line}',
          leafScope: 'CUSTOM-SCOPE {marker} {start}-{end}',
          budget: 'CUSTOM-BUDGET {chars}/{summary}/{rest}',
          skeleton: 'CUSTOM-SKELETON',
        },
      },
    },
    input: { messages: freshMessages(1) },
    agent: { session: { id: sessionId } },
    complete,
    sessionId,
    language: 'zh',
  })
  assert.match(instruction, /^CUSTOM-LEAF CUSTOM-SCOPE \[已压缩 · 不需要压缩\] 1-2/)
  assert.match(instruction, /CUSTOM-BUDGET 1000\/400\/600/)
  assert.match(instruction, /CUSTOM-SKELETON$/)
  store.close()
})

await test('a second compaction treats the prior digest as background, not fresh text', async () => {
  const store = new MemoryTreeStore(dbPath)
  const sessionId = 's-second'
  const first = await compactIntoTree({
    store,
    limits: { chunkTokens: 30000, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 8, branch: 4, maxMerges: 8 },
    input: { messages: freshMessages(2) },
    agent: { session: { id: sessionId } },
    complete: stubComplete('第一段摘要'),
    sessionId,
  })
  assert.equal(first.leaves, 1)
  const prior = store.roots(sessionId)[0]
  const checkpointText = renderNodeBlocks({ roots: [prior], stats: store.stats(sessionId) }).join('\n')
  const checkpointMessage = checkpoint(checkpointText)
  const livePrefix = [
    message('system', '你是小助。'),
    checkpointMessage,
    ...freshMessages(2).slice(1),
  ]
  const calls = []
  const answer = stubComplete('第二段摘要')
  const second = await compactIntoTree({
    store,
    limits: { chunkTokens: 30000, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 8, branch: 4, maxMerges: 8 },
    input: { messages: livePrefix },
    agent: { session: { id: sessionId } },
    complete: async (request) => {
      calls.push(request.messages)
      return answer(request)
    },
    sessionId,
  })
  assert.equal(second.leaves, 1)
  const roots = store.roots(sessionId)
  assert.equal(roots.length, 2)
  assert.equal(roots[0].id, prior.id)
  assert.ok(roots[1].msg_start > prior.msg_end, 'the new leaf must start after the covered range')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], checkpointMessage,
    'the live checkpoint message must be replayed verbatim, not re-rendered from the tree')
  assert.deepEqual(calls[0].slice(0, livePrefix.length), livePrefix,
    'the request prefix must match the live conversation before the compression instruction')
  store.close()
})

await test('over-full levels merge upward until the threshold is satisfied', async () => {
  const store = new MemoryTreeStore(dbPath)
  const sessionId = 's-merge'
  const result = await compactIntoTree({
    store,
    limits: { chunkTokens: 1, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 2, branch: 2, maxMerges: 8 },
    input: { messages: freshMessages(8) },
    agent: { session: { id: sessionId } },
    complete: stubComplete(),
    sessionId,
  })
  assert.ok(result.leaves >= 2)
  const stats = store.stats(sessionId)
  assert.ok(stats.depth >= 1, `expected a parent, got depth ${stats.depth}`)
  const roots = store.roots(sessionId)
  assert.ok(roots.some(row => row.level >= 1), 'a level-1 parent must be an active root')
  store.close()
})

await test('backward calls start with the longest, newest prefix', async () => {
  const store = new MemoryTreeStore(dbPath)
  const sessionId = 's-backward-calls'
  const calls = []
  const answer = stubComplete()
  await compactIntoTree({
    store,
    limits: { chunkTokens: 1, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 99, branch: 4, maxMerges: 8 },
    input: { messages: freshMessages(3) },
    agent: { session: { id: sessionId } },
    complete: async (request) => {
      calls.push(request.messages)
      return answer(request)
    },
    sessionId,
  })
  assert.ok(calls.length >= 3)
  assert.match(JSON.stringify(calls[0]), /第 3 个回答/)
  assert.doesNotMatch(JSON.stringify(calls.at(-1)), /第 2 个回答/)
  assert.match(JSON.stringify(calls.at(-1)), /第 1 个问题/)
  store.close()
})

await test('backward chunk calls still write original message ranges', async () => {
  const store = new MemoryTreeStore(dbPath)
  const sessionId = 's-backward'
  const result = await compactIntoTree({
    store,
    limits: { chunkTokens: 1, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 99, branch: 4, maxMerges: 8 },
    input: { messages: freshMessages(8) },
    agent: { session: { id: sessionId } },
    complete: stubComplete(),
    sessionId,
  })
  assert.ok(result.leaves >= 3)
  const leaves = store.activeAtLevel(sessionId, 0)
  assert.equal(leaves.length, result.leaves)
  assert.equal(leaves[0].msg_start, 1)
  assert.equal(leaves.at(-1).msg_end, result.covered)
  for (let index = 1; index < leaves.length; index += 1) {
    assert.equal(leaves[index].msg_start, leaves[index - 1].msg_end + 1,
      'leaf ranges must stay contiguous in original message order')
  }
  const serials = leaves.map(row => Number.parseInt(String(row.id).split('_')[1], 10))
  assert.deepEqual(serials, [...serials].sort((a, b) => a - b),
    'leaf ids must increase with the message timeline even when model calls run backward')
  store.close()
})

await test('explore_memory_tree requires a node id and replays a leaf original', async () => {
  const store = new MemoryTreeStore(dbPath)
  const sessionId = 's-tool'
  await compactIntoTree({
    store,
    limits: { chunkTokens: 30000, maxChunks: 12, nodeBudget: 1000, mergeThreshold: 8, branch: 4, maxMerges: 8 },
    input: { messages: freshMessages(1) },
    agent: { session: { id: sessionId } },
    complete: stubComplete('叶子摘要'),
    sessionId,
  })
  const root = store.roots(sessionId)[0]
  assert.match(describe(store, sessionId, undefined, {}), /需要 node_id/)
  const leaf = describe(store, sessionId, root.id, {})
  assert.match(leaf, /这一层是最具体的/)
  assert.match(leaf, /第 1 个问题/)
  const missing = describe(store, sessionId, 'node9_999', {})
  assert.match(missing, /这不代表记忆里没这件事/)
  let registered
  registerExploreTool({
    get: () => ({ register: (options) => { registered = options; return () => {} } }),
    effect: () => () => {},
  }, () => store, {})
  assert.deepEqual(registered.parameters.required, ['node_id'])
  assert.throws(
    () => registered.execute({}, { agent: { session: { id: sessionId } } }),
    /requires node_id/,
  )
  store.close()
})

rmSync(dir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('\nall smoke tests passed')
}
