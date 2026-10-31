/**
 * The compression model call.
 *
 * Compression needs a JSON answer, a fixed output budget, and thinking disabled.
 * A direct `ctx.llm.stream` call is the same seam `compaction-basic` uses, minus
 * its fixed instruction, which is the whole point of replacing the summarizer.
 *
 * @module @xiaob/dsh-memory-tree/llm
 */

/** Error carrying why a compression answer was unusable. */
export class CompressError extends Error {
  /**
   * @param {string} message what went wrong.
   * @param {{truncated?: boolean, parse?: boolean}} [flags] recovery hints.
   */
  constructor(message, flags = {}) {
    super(message)
    this.name = 'CompressError'
    this.truncated = flags.truncated === true
    this.parse = flags.parse === true
  }
}

/**
 * Build the model caller for one compaction run.
 *
 * `provider`/`model` come from the routed request so compression prices on the
 * same model the session is already using; a profile can override both.
 * @param {object} options
 * @param {object} options.ctx plugin context with the `llm` service.
 * @param {{provider: string, model: string}} options.route provider/model pair.
 * @param {string} [options.sessionId] session id forwarded for attribution.
 * @param {string} [options.purpose] request purpose tag.
 * @returns {(request: {messages: readonly object[], maxTokens: number, signal?: AbortSignal}) => Promise<{text: string, usage: object | undefined}>}
 *   caller that resolves to the streamed text.
 */
export function createCompleter({ ctx, route, sessionId, purpose = 'compaction' }) {
  return async function complete({ messages, maxTokens, signal }) {
    if (ctx?.llm?.stream === undefined) {
      throw new CompressError('llm service unavailable; cannot summarize into the tree')
    }
    let text = ''
    /** @type {object | null} */
    let finish = null
    /** @type {object | undefined} */
    let usage
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens,
      ...(sessionId === undefined ? {} : { sessionId }),
      purpose,
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish') finish = chunk.reason ?? null
      else if (chunk?.type === 'usage') usage = chunk.usage
    }
    if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
      throw new CompressError(String(finish.failure?.message ?? `compression ${finish.kind}`))
    }
    if (finish !== null && finish.kind === 'max-tokens') {
      throw new CompressError('compression truncated at the token cap', { truncated: true })
    }
    return { text, usage }
  }
}

/**
 * Parse a JSON answer that may be wrapped in a markdown fence or chatty prose.
 *
 * Recovery has three steps: strict JSON, then a markdown-fence/loose parse, then
 * pulling the `summary` string out of whatever came back. The loose parse is the
 * one that actually fires on most providers.
 * @param {string} text raw model output.
 * @returns {object} parsed JSON object.
 * @throws {CompressError} when no object can be recovered.
 */
export function parseNodeJson(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') throw new CompressError('compression returned no text', { parse: true })
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced !== null) candidates.push(fenced[1].trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // try the next candidate
    }
  }
  throw new CompressError('compression did not return parseable JSON', { parse: true })
}
