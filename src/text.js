/**
 * Message and node text helpers.
 *
 * Shared text helpers: flatten message content, build head/tail anchors, and
 * render the labelled node-line layout used in checkpoints.
 *
 * @module @xiaob/dsh-memory-tree/text
 */

import { renderFieldsLines, NODE_MARKER } from './schema.js'

/** Flatten a content value to text: text blocks joined, images as a placeholder. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('（图片）')
  }
  return parts.join('\n')
}

/** How many image blocks a content value carries. */
export function imageCount(content) {
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'image') count += 1
  }
  return count
}

/**
 * Rough token estimate: text characters x 1.2, plus 384 per image.
 * Base64 data URLs must never be counted as characters — one 1 MB image is a
 * million "characters" and fires compaction on a nearly empty buffer.
 * @param {object} message request message.
 * @returns {number} rough token count.
 */
export function estimateTokens(message) {
  const chars = contentText(message?.content).length
  return Math.trunc(chars * 1.2) + imageCount(message?.content) * 384
}

/** Whether an assistant message asked for tools (a chunk must never split there). */
export function hasToolCalls(message) {
  if (!Array.isArray(message?.content)) return false
  return message.content.some(block => block !== null && typeof block === 'object'
    && block.type === 'tool-call')
}

/**
 * Names of the tools one assistant message asked for.
 *
 * An assistant turn that only calls tools has no text at all, so anything that
 * flattens messages to text (`anchorQuotes`, the leaf replay) loses *what was
 * called* unless it reads the blocks — leaving a tool result with no visible
 * cause.
 * @param {object} message request message.
 * @returns {string[]} tool names, in call order.
 */
export function toolCallNames(message) {
  if (!Array.isArray(message?.content)) return []
  return message.content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'tool-call')
    .map(block => String(block.name ?? '(unnamed)'))
}

/**
 * Head/tail anchors that name a chunk's range without quoting it.
 *
 * The chunk travels as real messages, so the instruction only needs to point at
 * its edges. The head
 * is the first body text (skipping empty assistant tool-call turns, up to four
 * messages), the tail is the last body text's ending (up to four back) — without
 * which a model reads the final tool result as background and stops early.
 * @param {readonly object[]} chunk one chunk of messages.
 * @returns {{head: string, tail: string}} anchors.
 */
export function anchorQuotes(chunk) {
  let head = ''
  for (const message of chunk.slice(0, 4)) {
    const text = contentText(message?.content).trim()
    if (text !== '') {
      head = text.slice(0, 120)
      break
    }
  }
  if (head === '') {
    const names = toolCallNames(chunk[0])
    head = names.length > 0 ? `（助手调用工具：${names.join('、')}）` : '（本片开头）'
  }
  let tail = ''
  for (const message of [...chunk.slice(-4)].reverse()) {
    const text = contentText(message?.content).trim()
    if (text !== '') {
      tail = text.slice(-60)
      break
    }
  }
  return { head, tail }
}

/** `YYYY-MM-DD HH:MM ~ HH:MM`, collapsing the date when both ends share one day. */
export function formatTimeRange(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string' || start === '' || end === '') return ''
  const a = start.replace('T', ' ')
  const b = end.replace('T', ' ')
  const full = ts => ts.slice(0, 16)
  const hm = ts => ts.slice(11, 16)
  return a.slice(0, 10) === b.slice(0, 10) ? `${full(a)} ~ ${hm(b)}` : `${full(a)} ~ ${full(b)}`
}

/**
 * One node as rendered into the conversation.
 *
 *   [node0_003 · L0 · 第13-18条] [已压缩 · 不需要压缩]
 *   [摘要] …
 *   [时间] …
 *   [任务] …   (fields, empty groups omitted)
 *
 * @param {object} node node row (`id`, `level`, `summary`, `msg_start`, `msg_end`, `meta`, `time_start`, `time_end`).
 * @param {{marker?: boolean}} [options] `marker: false` renders the version fed back as a merge target.
 * @returns {string} node text.
 */
export function nodeText(node, options = {}) {
  const level = Number(node['level'] ?? 0)
  let head = `[${node['id']} · L${level} · 第${node['msg_start']}-${node['msg_end']}条]`
  if (options.marker !== false) head += ` ${NODE_MARKER}`
  const lines = [head, `[摘要] ${String(node['summary'] ?? '').trim()}`]
  const time = formatTimeRange(node['time_start'], node['time_end'])
  if (time !== '') lines.push(`[时间] ${time}`)
  const fields = node['meta']?.fields
  if (options.summaryOnly !== true && fields !== null && typeof fields === 'object') {
    // A row from an older build (or a hand-edited one) can lack a nested group.
    // Rendering must not be able to take the whole checkpoint down with it: an
    // unrenderable field set costs the reader the field lines, not the node —
    // and a fallback to a flat summary would cost every other node too.
    try {
      lines.push(...renderFieldsLines(fields))
    } catch {
      lines.push('[字段] （这条节点的字段结构不完整，只能看上面的摘要）')
    }
  }
  return lines.join('\n')
}

/** Collapse whitespace and cap one excerpt. */
export function excerpt(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** Local `YYYY-MM-DD HH:MM` for a unix-second timestamp. */
export function stamp(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Whether a message is an earlier compaction checkpoint, i.e. its contents are
 * already represented in the tree.
 * @param {object} message request message.
 * @returns {boolean} true for the checkpoint.
 */
export function isCheckpoint(message) {
  const source = message?.source
  // `@deepseek-ai/dsh-compaction` stamps checkpoints with `kind`, not `type`
  // (`compactCheckpointSource()` returns `{ kind: 'compact-checkpoint', ... }`).
  // Accepting both keeps checkpoints written by an older/other build detectable;
  // getting this wrong folds the previous digest back in as fresh raw text and
  // grows a duplicate leaf on every later compaction.
  if (source !== null && typeof source === 'object'
    && (source.kind === 'compact-checkpoint' || source.type === 'compact-checkpoint')) return true
  if (message?.role !== 'user') return false
  // Older checkpoints (and test fixtures) may have lost their source. The digest
  // header is still a durable marker, but it sits after the backend's preamble
  // and `<compacted-summary>` tag, so look for it anywhere near the start.
  const text = contentText(message?.content).trimStart()
  if (text.startsWith(DIGEST_MARK)) return true
  const tag = '<compacted-summary>'
  const at = text.indexOf(tag)
  return at >= 0 && text.slice(at + tag.length).trimStart().startsWith(DIGEST_MARK)
}

/** Header of the checkpoint body; the first line is also the durable marker. */
export const DIGEST_MARK = '[记忆树]'

/**
 * Render the checkpoint: a header plus one block per active root node.
 *
 * DSH checkpoints are a single user message, so nodes become content blocks
 * rather than messages. That keeps every node individually addressable — which
 * is the whole point.
 * @param {object} input header inputs.
 * @param {readonly object[]} input.roots active nodes, oldest first.
 * @param {{active: number, depth: number, covered: number}} input.stats tree statistics.
 * @param {boolean} [input.summaryOnly] drop the field lines to fit a small span.
 * @returns {string[]} blocks: header first, then one per node.
 */
export function renderNodeBlocks({ roots, stats, summaryOnly = false }) {
  const blocks = [
    `${DIGEST_MARK} 共 ${stats.active} 个活跃节点，深度 L${Math.max(0, stats.depth)}，`
    + `已折叠到第 ${stats.covered} 条。下面每段是一个节点，编号、范围、时间和摘要都已经在这里；`
    + '编号 node<层级>_<该层序号> 的序号按该层时间顺序分配；找时间段请看「第a-b条」和「[时间]」。'
    + '根节点也按消息范围从旧到新排列。摘要和字段够用就直接回答，不必再查；只有需要子节点或叶子原文时，'
    + '才调用 explore_memory_tree(node_id)，一次传一个 node_id，不必翻到最底层。\n',
  ]
  if (roots.length === 0) blocks.push('（本会话还没有可折叠的历史。）\n')
  else for (const row of roots) blocks.push(`${nodeText(row, { summaryOnly })}\n`)
  return blocks
}
