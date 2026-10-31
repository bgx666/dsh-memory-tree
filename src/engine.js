/**
 * The compaction pipeline: raw conversation -> level-0 nodes -> merged parents
 * -> the node blocks that become the checkpoint.
 *
 * The parts that matter, in the order the run does them:
 *
 *   1. split the batch into ~30k-token chunks, cutting on turn boundaries;
 *   2. chunk k is sent with chunks 1..k-1 in front of it (progressive prefix),
 *      so each call extends the previous one and the provider cache still hits;
 *   3. the instruction only *names* the range — head/tail anchor quotes — the
 *      text itself travels as real messages, never spliced into the prompt;
 *   4. answers are JSON (summary + task/decisions/lessons/context/user), clipped
 *      to a whole-node character budget;
 *   5. every level merges oldest-`branch`-of-`threshold` into one parent, and a
 *      round keeps merging until the level is under threshold again.
 *
 * @module @xiaob/dsh-memory-tree/engine
 */

import { splitByTokens } from './chunk.js'
import { CompressError, parseNodeJson } from './llm.js'
import { load, render } from './prompts.js'
import { applyBudget, coerceFields, emptyFields, NODE_MARKER, SCHEMA_VERSION } from './schema.js'
import { anchorQuotes, isCheckpoint, nodeText, renderNodeBlocks } from './text.js'

/** Whole-node character budget split: 40% summary / 60% fields. */
export function nodeBudget(limits, language = 'zh') {
  const budget = Math.max(200, Math.trunc(Number(limits.nodeBudget) || 1000))
  const chars = language === 'en' ? Math.trunc(budget * 3.5) : budget
  return { chars, summary: Math.max(40, Math.trunc((chars * 2) / 5)) }
}

/** One configured prompt template, or undefined for the shipped file. */
function promptOf(limits, kind, language) {
  const value = limits?.prompts?.[language]?.[kind]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The budget line the instruction carries, e.g. "整节点合计约 1000 字以内". */
function budgetLine(limits, language) {
  const { chars, summary } = nodeBudget(limits, language)
  return render(
    `compress/budget_${language}`,
    { chars, summary, rest: chars - summary },
    promptOf(limits, 'budget', language),
  )
}

/** Cell value for the instruction's working-directory line. */
function cwdLine(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  return `- 当前工作目录（系统会填进 context.cwd，你不用填）：${cwd}\n`
}

/** Resolve the workspace directory if the agent exposes one. */
function resolveCwd(agent) {
  const candidates = [
    agent?.options?.cwd,
    agent?.session?.cwd,
    agent?.session?.workspaceRoot,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** Render the leaf instruction for one chunk. */
function leafInstruction({ start, end, anchor, anchorEnd, limits, language, cwd }) {
  const chunked = anchor !== '' || anchorEnd !== ''
  const scope = chunked
    ? render(`compress/leaf_scope_chunk_${language}`, {
      marker: NODE_MARKER, start, end, anchor, anchor_end: anchorEnd,
    }, promptOf(limits, 'leafScopeChunk', language))
    : render(
      `compress/leaf_scope_${language}`,
      { marker: NODE_MARKER, start, end },
      promptOf(limits, 'leafScope', language),
    )
  return render(`compress/leaf_${language}`, {
    scope,
    cwd_line: cwdLine(cwd),
    budget_line: budgetLine(limits, language),
  }, promptOf(limits, 'leaf', language)) + load(
    `compress/skeleton_${language}`,
    promptOf(limits, 'skeleton', language),
  )
}

/** Render the parent instruction naming the nodes to merge. */
function parentInstruction({ ids, limits, language }) {
  return render(`compress/parent_${language}`, {
    marker: NODE_MARKER,
    n: ids.length,
    ids: ids.join('、'),
    budget_line: budgetLine(limits, language),
  }, promptOf(limits, 'parent', language)) + load(
    `compress/skeleton_${language}`,
    promptOf(limits, 'skeleton', language),
  )
}

/** One text message for the compression request. */
function textMessage(role, text) {
  return { role, content: [{ type: 'text', text }] }
}

/**
 * Ask for one node and normalize what comes back.
 *
 * A truncated or unparseable answer gets one retry that says so and asks for a
 * shorter, closed JSON — resending the identical request reproduces the identical
 * cut-off, so one retry is enough to change the outcome.
 * @returns {Promise<{summary: string, fields: object, raw: string}>} normalized node.
 */
async function requestNode({ complete, messages, limits, language, signal }) {
  const { chars, summary } = nodeBudget(limits, language)
  const attempt = async (requestMessages, maxTokens) => {
    const { text } = await complete({ messages: requestMessages, maxTokens, signal })
    const parsed = parseNodeJson(text)
    const clipped = applyBudget(
      { summary: String(parsed['summary'] ?? '').trim(), fields: coerceFields(parsed) },
      limits.nodeBudget,
    )
    if (clipped.summary === '') throw new CompressError('compression produced an empty summary', { parse: true })
    return { summary: clipped.summary, fields: clipped.fields, raw: text }
  }
  const firstTokens = Math.max(3000, Math.trunc(Number(limits.nodeBudget) || 1000) * 3)
  try {
    return await attempt(messages, firstTokens)
  } catch (error) {
    if (!(error instanceof CompressError) || (!error.truncated && !error.parse)) throw error
    const hint = render(
      `compress/retry_${language}`,
      { chars, summary },
      promptOf(limits, 'retry', language),
    )
    const retryMessages = [...messages, textMessage('user', hint)]
    return attempt(retryMessages, Math.max(6000, firstTokens * 2))
  }
}

/**
 * Fold the region's fresh tail into the tree and return the checkpoint blocks.
 *
 * @param {object} options
 * @param {import('./store.js').MemoryTreeStore} options.store open tree store.
 * @param {object} options.limits resolved budgets.
 * @param {{messages?: readonly object[]}} options.input the replayed region.
 * @param {object} options.agent owning agent.
 * @param {(request: object) => Promise<{text: string, usage?: object}>} options.complete model caller.
 * @param {AbortSignal} [options.signal] cancellation.
 * @param {string} [options.sessionId] partition key; defaults to `agent.session.id`.
 * @param {'zh' | 'en'} [options.language] instruction language.
 * @param {(kind: string, detail: string) => void} [options.onEvent] progress reporter.
 * @param {Map<object, number>} [options.times] message -> epoch ms, when the caller could
 *   index the session log; absent means the region's times are unknown.
 * @returns {Promise<{blocks: string[], text: string, covered: number, leaves: number, merges: number, chars: number}>}
 *   checkpoint blocks plus what this run produced; `covered` counts the oldest
 *   region messages that were actually folded (a chunk cap can leave a tail).
 */
export async function compactIntoTree({
  store, limits, input, agent, signal, complete, sessionId, language = 'zh', onEvent, times, onNodeId,
}) {
  const partition = String(sessionId ?? agent?.session?.id ?? 'unknown')
  const messages = Array.isArray(input?.messages) ? input.messages : []
  const head = messages[0]?.role === 'system' ? messages[0] : undefined
  const region = head === undefined ? messages : messages.slice(1)
  const checkpointAt = region.findIndex(isCheckpoint)
  const fresh = checkpointAt >= 0 ? region.slice(checkpointAt + 1) : region
  const cwd = resolveCwd(agent)
  /** Every node this run wrote, so a failed commit can be rolled back. */
  const created = []
  /**
   * Region messages this run actually summarized. A chunk cap can leave the
   * newest messages unsummarized; the caller must shrink the replacement range
   * to this prefix or those messages would vanish from the surface.
   */
  let covered = checkpointAt >= 0 ? checkpointAt + 1 : 0

  let leaves = 0
  if (fresh.length > 0) {
    const chunks = splitByTokens(fresh, limits.chunkTokens, limits.maxChunks)
    onEvent?.('start', `fresh=${fresh.length}\tchunks=${chunks.length}`)
    const base = store.nextOrdinal(partition)
    // Snapshot before the run: the nodes of this run's own chunks are already
    // replayed as raw prefix messages, and repeating them as summary lines would
    // put the same span into the prompt twice.
    const folded = store.roots(partition).map(row => textMessage('user', nodeText(row)))
    let offset = 0
    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted?.()
      const start = base + offset
      const end = start + chunk.length - 1
      // Progressive prefix: every earlier chunk rides along as background. That
      // is what makes the second call share a byte-identical prefix with the
      // first instead of re-pricing the whole batch.
      const prefix = chunks.slice(0, index + 1).flat()
      const { head: anchor, tail: anchorEnd } = chunks.length > 1
        ? anchorQuotes(chunk)
        : { head: '', tail: '' }
      const request = [
        ...(head === undefined ? [] : [head]),
        ...folded,
        ...prefix,
        textMessage('user', leafInstruction({
          start, end, anchor, anchorEnd, limits, language, cwd,
        })),
      ]
      let node
      let degraded = false
      try {
        node = await requestNode({ complete, messages: request, limits, language, signal })
      } catch (error) {
        if (!(error instanceof CompressError)) throw error
        // A chunk that cannot be summarized still has to land, or its messages
        // are dropped from the context with nothing to show for them.
        node = mechanicalNode(chunk)
        degraded = true
      }
      const fields = { ...node.fields }
      if (fields.context.cwd === '' && cwd !== '') fields.context.cwd = cwd
      const leafId = store.addLeaf({
        sessionId: partition,
        summary: node.summary,
        details: chunk.map(message => ({
          role: message.role,
          content: message.content,
          ...(times?.has(message) ? { time: wallClock(times.get(message)) } : {}),
        })),
        meta: { schema_version: SCHEMA_VERSION, fields },
        count: chunk.length,
        dedupeKey: null,
        timeRange: timeRangeOf(chunk, times),
      })
      created.push(leafId)
      onNodeId?.(leafId)
      offset += chunk.length
      covered += chunk.length
      leaves += 1
      onEvent?.('leaf', `n=${index + 1}/${chunks.length}\trange=${start}-${end}`
        + `\tsummary=${node.summary.length}\tkind=${degraded ? 'mechanical (model answer unusable)' : 'model'}`)
    }
  }

  const merges = await mergeUp({
    store, limits, partition, head, complete, signal, language, cwd, onEvent, created, onNodeId,
  })

  const stats = store.stats(partition)
  const roots = store.roots(partition)
  let blocks = renderNodeBlocks({ roots, stats })
  // The backend refuses a replacement that does not price below the span it
  // shadows. Summary-only nodes are the graceful degradation: the ids, ranges
  // and summaries stay addressable, only the field lines are dropped.
  const regionChars = messages.reduce((total, message) => total + textOf(message).length, 0)
  if (regionChars > 0 && blocks.join('\n').length > regionChars * 0.9) {
    // Silent degradation is the failure mode this whole file exists to avoid:
    // the checkpoint keeps ids and ranges but loses every structured line, which
    // looks like "the plugin did nothing" from the transcript.
    onEvent?.('shrink', `full=${blocks.join('\n').length}\tregion=${regionChars}`
      + '\tdropping field lines to stay below the shadowed span')
    blocks = renderNodeBlocks({ roots, stats, summaryOnly: true })
  }
  return {
    blocks,
    text: blocks.join('\n'),
    covered,
    leaves,
    merges,
    chars: blocks.join('\n').length,
    nodeIds: created,
  }
}

/** Concatenated text of a message, for the shrink check. */
function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** The harness's own time sample, written into the user turn it prepares. */
const SAMPLE_STAMP = /Time sampled while preparing[^:\n]*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s\[]*)/

/** Local `YYYY-MM-DDTHH:MM:SS` — the shape `formatTimeRange` slices. */
function wallClock(ms) {
  const date = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * The wall clock one chunk covers.
 *
 * Three sources, best first. **Session events** are authoritative: the caller
 * indexed the log by message identity, so these are the times the harness
 * stamped when it accepted each turn (`event.time`), not an inference. **The
 * time-context sample** is the fallback, for when the log could not be walked —
 * it is a user turn the harness writes, so its ISO stamp is real too. Anything
 * else is "unknown": a timestamp that appears inside a tool output must never be
 * reported as when the conversation happened.
 * @param {readonly object[]} chunk one chunk of messages.
 * @param {Map<object, number>} [times] message -> epoch ms.
 * @returns {[string, string] | null} start and end, or null when nothing states a time.
 */
function timeRangeOf(chunk, times) {
  if (times !== undefined && times.size > 0) {
    const stamped = []
    for (const message of chunk) {
      const ms = times.get(message)
      // All or nothing: a partly covered chunk would start at the first message
      // that happened to match, which is worse than the fallback's approximation.
      if (typeof ms !== 'number') {
        stamped.length = 0
        break
      }
      stamped.push(wallClock(ms))
    }
    if (stamped.length > 0) return [stamped[0], stamped[stamped.length - 1]]
  }
  const first = chunk[0]?.timestamp ?? chunk[0]?.ts
  const last = chunk[chunk.length - 1]?.timestamp ?? chunk[chunk.length - 1]?.ts
  if (typeof first === 'string' && typeof last === 'string') return [first, last]
  const samples = []
  for (const message of chunk) {
    const match = SAMPLE_STAMP.exec(textOf(message))
    if (match !== null) samples.push(match[1])
  }
  return samples.length === 0 ? null : [samples[0], samples[samples.length - 1]]
}

/**
 * Land a node without a model: keep the opening of the chunk as the summary.
 * A poor summary beats dropping the messages from the context entirely, and a
 * later merge can still digest it.
 * @param {readonly object[]} chunk the messages that could not be summarized.
 * @returns {{summary: string, fields: object}} node content.
 */
function mechanicalNode(chunk) {
  const text = chunk.map(message => {
    const body = textOf(message)
    return body === '' ? '' : `${message.role}: ${body}`
  }).filter(line => line !== '').join('\n')
  const summary = text.slice(0, 400).replace(/\s+/g, ' ').trim()
  return {
    summary: summary === '' ? '（这一段对话无法摘要，原文已随节点保存）' : `${summary}…`,
    fields: emptyFields(),
  }
}

/**
 * Merge over-full levels bottom-up until every level is under threshold.
 *
 * Input is nodes only — raw messages never enter a merge — and nodes that start
 * after the merge target are excluded: they are "future" information relative to
 * the span being folded, and letting them in pollutes the summary with state the
 * span had not reached yet.
 * @returns {Promise<number>} parents created.
 */
async function mergeUp({ store, limits, partition, head, complete, signal, language, cwd, onEvent, created, onNodeId }) {
  let merges = 0
  let batches = 0
  for (let level = 0; batches < limits.maxMerges;) {
    signal?.throwIfAborted?.()
    const nodes = store.activeAtLevel(partition, level)
    if (nodes.length < limits.mergeThreshold) {
      const depth = store.stats(partition).depth
      if (level > depth) break
      level += 1
      continue
    }
    const targets = nodes.slice(0, limits.branch)
    const targetIds = new Set(targets.map(node => node['id']))
    const cutoff = Math.max(...targets.map(node => Number(node['msg_start'])))
    const context = []
    for (const row of store.roots(partition)) {
      if (targetIds.has(row['id'])) {
        context.push(textMessage('user', nodeText(row, { marker: false })))
        continue
      }
      if (Number(row['msg_start']) > cutoff) continue
      context.push(textMessage('user', nodeText(row)))
    }
    const request = [
      ...(head === undefined ? [] : [head]),
      ...context,
      textMessage('user', parentInstruction({ ids: [...targetIds], limits, language })),
    ]
    let node
    try {
      node = await requestNode({ complete, messages: request, limits, language, signal })
    } catch (error) {
      if (!(error instanceof CompressError)) throw error
      break
    }
    const fields = { ...node.fields }
    if (fields.context.cwd === '' && cwd !== '') fields.context.cwd = cwd
    const parentId = store.merge({
      sessionId: partition,
      childIds: [...targetIds],
      summary: node.summary,
      meta: { schema_version: SCHEMA_VERSION, fields },
    })
    created.push(parentId)
    onNodeId?.(parentId)
    merges += 1
    batches += 1
    onEvent?.('merge', `level=${level}\tchildren=${targetIds.size}\tparents=${merges}`)
  }
  return merges
}
