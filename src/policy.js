/**
 * Policy and transcript helpers for the asynchronous compaction path.
 *
 * These functions are dependency-free so they can be tested without a running
 * Harness: pricing a routed model, selecting the oldest balanced span, replaying
 * exactly the region the backend would summarize, and checking the idle locks
 * before a checkpoint lands.
 *
 * @module @xiaob/dsh-memory-tree/policy
 */

/** Opening sentence of the checkpoint; same framing compaction-basic uses. */
export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span '
  + 'of the conversation to free up context. Treat the captured context as established background '
  + 'and build on it without restating it. Continue the task directly from the messages that follow, '
  + 'without acknowledging this checkpoint.'

/** Tags wrapping the tree digest inside the checkpoint message. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Merge one model-specific policy over the engine's defaults. */
function policyFor(config, target) {
  const override = Array.isArray(config?.modelPolicies)
    ? config.modelPolicies.find(row => row?.provider === target.provider && row?.model === target.model)
    : undefined
  const pick = (key, fallback) => override?.[key] ?? config?.[key] ?? fallback
  return {
    thresholdRatio: pick('thresholdRatio', 0.8),
    headroomTokens: pick('headroomTokens', 65_536),
    maxTokens: pick('maxTokens', undefined),
  }
}

/**
 * Price the next request against the routed model's window.
 *
 * This is the small part of `compaction-basic` the async path needs before it
 * can decide whether to summarize at all; the commit still goes through the
 * framework's own event sequence and token meter.
 * @param {object} config the engine's resolved config.
 * @param {object} header the session's latest durable request header.
 * @param {object} info the adapter's resolved model info.
 * @param {{triggerTokens?: number, retainMessages?: number}} [limits] explicit
 *   budgets; `0`/absent falls back to the window-ratio policy.
 * @param {{contextWindow?: number, pressureTokens?: number, projectedTokens?: number}} [pressure]
 *   the token meter's live context-pressure view (the same denominator the
 *   composer percentage uses), preferred over the adapter capacity so the
 *   trigger and the visible percentage agree.
 * @returns {{thresholdTokens: number, retainMessages: number} | null} null when
 *   the model cannot be priced (no window), in which case the caller falls back
 *   to the backend's synchronous policy.
 */
export function resolveSpec(config, header, info, limits = {}, pressure) {
  const contextWindow = Number.isInteger(pressure?.contextWindow) && pressure.contextWindow > 0
    ? pressure.contextWindow
    : info?.context?.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null
  const target = header?.config
  if (target === undefined || typeof target.provider !== 'string') return null
  const policy = policyFor(config, target)
  const reserved = Number(target.maxTokens ?? info?.defaultMaxTokens ?? 0)
  const messageBudget = contextWindow - reserved
  if (messageBudget <= 0) return null
  const pressureBudget = messageBudget - Number(policy.headroomTokens ?? 0)
  if (pressureBudget <= 0) return null
  const fixedTrigger = Number(limits?.triggerTokens ?? 0)
  const thresholdTokens = fixedTrigger > 0
    ? Math.min(fixedTrigger, pressureBudget)
    : Math.floor(Math.min(contextWindow * Number(policy.thresholdRatio), pressureBudget))
  // Retention is deliberately a *message count* only. Mixing in a token budget
  // would make it impossible to tell which rule produced the cut.
  const retainMessages = Math.max(0, Math.trunc(Number(limits?.retainMessages ?? 0)))
  if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return null
  return { thresholdTokens, retainMessages }
}

/**
 * Select the oldest balanced span to compact, retaining a recent tail.
 * Mirrors `selectCompactableRange` in the backend; kept here because the async
 * path must snapshot the span before the summarizing request starts.
 * @param {object} session live session (only `surface` and `eventAt` are read).
 * @param {object} measurement token-meter measurement for the current surface.
 * @param {number} retainMessages keep at least this many whole messages from
 *   the tail; this is the only retention rule.
 * @param {(session: object, seq: number) => boolean} balancedBefore tool-pair predicate.
 * @returns {{start: number, end: number, startIdx: number, endIdx: number} | null}
 *   an inclusive surface span, or null when nothing safe remains.
 */
export function selectRange(
  session, measurement, retainMessages, balancedBefore,
) {
  const priced = measurement?.nodes
  const nodes = session?.surface?.nodes
  if (!Array.isArray(priced) || !Array.isArray(nodes) || priced.length !== nodes.length) return null
  if (nodes.some((seq, index) => seq !== priced[index]?.seq)) return null
  if (nodes.length === 0) return null
  const headEvent = session.eventAt(nodes[0])
  const firstIdx = headEvent?.type === 'system/message' ? 1 : 0
  // Retention is a count. Zero is treated as "keep the newest one" rather than
  // "compress everything", which would leave the model without a turn to answer.
  let keepFromIdx = Math.max(firstIdx, nodes.length - Math.max(1, Math.trunc(retainMessages)))
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx && !balancedBefore(session, nodes[keepFromIdx])) {
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return {
    start: nodes[firstIdx],
    end: nodes[keepFromIdx - 1],
    startIdx: firstIdx,
    endIdx: keepFromIdx - 1,
  }
}

/** Replay one surface span exactly as the backend does for its summarizer. */
export function buildInput(session, seqs) {
  const surface = session.surface.nodes
  const headEvent = surface.length > 0 ? session.eventAt(surface[0]) : undefined
  const system = headEvent?.type === 'system/message' ? session.deriveEventMessage(headEvent) : null
  const messages = []
  for (const seq of seqs) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    const message = session.deriveEventMessage(event)
    if (message !== null && message !== undefined) messages.push(message)
  }
  const header = session.requestHeader()
  return {
    messages: system === null ? messages : [system, ...messages],
    ...header?.tools === undefined ? {} : { tools: header.tools },
  }
}

/**
 * Check the durable locks an idle commit must respect: no open turn and no
 * unmatched `compaction/start` from this or an earlier lifecycle.
 * @param {object} session live session (only `seq` and `eventAt` are read).
 * @returns {{openTurn: number | null, unmatched: object | undefined}} lock state.
 */
export function inspectIdle(session) {
  let openTurn = null
  let turnKnown = false
  let unmatched
  let compactionKnown = false
  let latestSeed
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    if (latestSeed === undefined && event.type === 'session/end-seed') latestSeed = event.seq
    if (!compactionKnown) {
      if (event.type === 'compaction/start') {
        unmatched = event
        compactionKnown = true
      } else if (event.type === 'compaction/end') {
        compactionKnown = true
      }
    }
    if (!turnKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data?.turn ?? 0
        turnKnown = true
      } else if (event.type === 'turn/end') {
        turnKnown = true
      }
    }
    if (turnKnown && compactionKnown && latestSeed !== undefined) break
  }
  if (unmatched !== undefined && latestSeed !== undefined && latestSeed > unmatched.seq) {
    unmatched = undefined
  }
  return { openTurn, unmatched }
}

/** Frame the tree digest as the checkpoint user message content blocks. */
export function frameBlocks(blocks) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...blocks.map(text => ({ type: 'text', text })),
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Whether two surface-seq arrays are the same span. */
export function sameSeqs(left, right) {
  return left.length === right.length && left.every((seq, index) => seq === right[index])
}
