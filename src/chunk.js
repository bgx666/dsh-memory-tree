/**
 * Chunk splitting, ported from planner's `_split_batch_by_tokens`.
 *
 * The chunker exists to serve the progressive-prefix call pattern: chunk k is
 * sent together with chunks 1..k-1, so the provider's cached prefix covers
 * everything before it. Cuts therefore prefer real turn boundaries, and never
 * land inside a tool call/result pair — such a batch is sent as messages, and a
 * broken pair is a 400 from the provider.
 *
 * @module @xiaob/dsh-memory-tree/chunk
 */

import { contentText, hasToolCalls } from './text.js'

/** Accept a chunk once it reaches this fraction of the target and a turn boundary. */
export const CHUNK_FLOAT_LO = 0.75
/** Close a chunk here even without a turn boundary. */
export const CHUNK_FLOAT_HI = 1.4

/** Character-based token estimate used for splitting (images excluded). */
export function charTokens(message) {
  return Math.trunc(contentText(message?.content).length * 1.2)
}

/**
 * Split one leaf batch into token-sized chunks.
 *
 * @param {readonly object[]} messages the batch, oldest first.
 * @param {number} [maxTokens] target size per chunk; `<= 0` disables splitting.
 * @param {number} [maxChunks] hard cap; the remainder is left for the next round.
 * @returns {object[][]} chunks, oldest first.
 */
export function splitByTokens(messages, maxTokens = 30000, maxChunks = 12) {
  if (maxTokens <= 0 || messages.length === 0) return [messages.slice()]
  const chunks = []
  let current = []
  let tokens = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    current.push(message)
    tokens += charTokens(message)
    if (index === messages.length - 1) break
    const next = messages[index + 1]
    // Unsafe boundary: cutting here would separate a tool call from its result.
    if (next?.role === 'tool' || hasToolCalls(message)) continue
    const turnBoundary = next?.role === 'user'
    const close = (turnBoundary && tokens >= maxTokens * CHUNK_FLOAT_LO)
      || tokens >= maxTokens * CHUNK_FLOAT_HI
    if (!close) continue
    chunks.push(current)
    current = []
    tokens = 0
    if (chunks.length >= maxChunks) break
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Total estimated tokens of a batch (splitting estimate). */
export function batchTokens(messages) {
  let total = 0
  for (const message of messages) total += charTokens(message)
  return total
}
