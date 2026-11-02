/**
 * Memory-tree compaction for DeepSeek Harness.
 *
 * Replaces the summarization step of the installed compaction backend while
 * leaving everything else — locking, tool pairing, replacement, shrink
 * validation, automatic triggers — to that backend's own code.
 *
 * The hook is installed on `BasicCompactionEngine.prototype`, not on the
 * instance found through `ctx.compaction`. A service lookup is the fragile part:
 * it depends on which fiber mounted the backend and in what order, and a miss is
 * completely silent (the plugin is never constructed, so the session just keeps
 * writing flat summaries with no error to show for it). The prototype is the one
 * object this plugin and the backend provably share, because the resolver hands
 * both the same module.
 *
 * @module @xiaob/dsh-memory-tree
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import * as baseModule from '@deepseek-ai/dsh-compaction-basic'
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { compactIntoTree } from './src/engine.js'
import { createCompleter } from './src/llm.js'
import { buildInput, frameBlocks, inspectIdle, resolveSpec, sameSeqs, selectRange } from './src/policy.js'
import { MemoryTreeStore, harnessHome } from './src/store.js'
import { renderNodeBlocks } from './src/text.js'
import { registerExploreTool } from './src/tool.js'


const Base = baseModule.default ?? baseModule.BasicCompactionEngine
if (typeof Base !== 'function') {
  throw new Error('@xiaob/dsh-memory-tree: cannot resolve BasicCompactionEngine from @deepseek-ai/dsh-compaction-basic')
}

/** Package root, used to read the shipped prompt templates as schema defaults. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** One shipped prompt as its schema default, or an empty string if absent. */
function promptDefault(name) {
  try {
    return readFileSync(join(PACKAGE_ROOT, 'prompts', 'compress', `${name}.md`), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Profile configuration becomes the Settings page. The prompt fields default
 * to the shipped templates, so a fresh install shows editable text instead of
 * an empty box; clearing a field restores that default.
 */
export const Config = z.object({
  chunkTokens: z.number().step(1).min(1).default(30000).volatile(),
  maxChunks: z.number().step(1).min(1).default(12).volatile(),
  nodeBudget: z.number().step(1).min(200).default(1000).volatile(),
  mergeThreshold: z.number().step(1).min(2).default(8).volatile(),
  branch: z.number().step(1).min(2).default(4).volatile(),
  maxMerges: z.number().step(1).min(1).default(8).volatile(),
  triggerTokens: z.number().step(1).min(0).default(0).volatile(),
  retainMessages: z.number().step(1).min(0).default(20).volatile(),
  language: z.string().default('zh').volatile(),
  async: z.boolean().default(true).volatile(),
  mode: z.string().default('').volatile(),
  summaryProvider: z.string().default('').volatile(),
  summaryModel: z.string().default('').volatile(),
  promptLeafZh: z.string().default(promptDefault('leaf_zh')).volatile(),
  promptLeafEn: z.string().default(promptDefault('leaf_en')).volatile(),
  promptLeafScopeZh: z.string().default(promptDefault('leaf_scope_zh')).volatile(),
  promptLeafScopeEn: z.string().default(promptDefault('leaf_scope_en')).volatile(),
  promptLeafScopeChunkZh: z.string().default(promptDefault('leaf_scope_chunk_zh')).volatile(),
  promptLeafScopeChunkEn: z.string().default(promptDefault('leaf_scope_chunk_en')).volatile(),
  promptBudgetZh: z.string().default(promptDefault('budget_zh')).volatile(),
  promptBudgetEn: z.string().default(promptDefault('budget_en')).volatile(),
  promptSkeletonZh: z.string().default(promptDefault('skeleton_zh')).volatile(),
  promptSkeletonEn: z.string().default(promptDefault('skeleton_en')).volatile(),
  promptParentZh: z.string().default(promptDefault('parent_zh')).volatile(),
  promptParentEn: z.string().default(promptDefault('parent_en')).volatile(),
  promptRetryZh: z.string().default(promptDefault('retry_zh')).volatile(),
  promptRetryEn: z.string().default(promptDefault('retry_en')).volatile(),
})

/**
 * Append one tab-separated line per lifecycle event to
 * `<DSH_HOME>/memory-tree/plugin.log`.
 *
 * A plugin that silently fails to load is indistinguishable from one that was
 * never installed, and a compaction that quietly fell back to a flat summary is
 * indistinguishable from one that grew the tree. Both are recorded where they
 * can be read after the fact — `node src/status.js` prints this log.
 * @param {string} event `import`, `activate`, `compact`, `fallback`, or `patchfail`.
 * @param {string} fields tab-separated `key=value` detail.
 * @returns {void}
 */
function record(event, fields) {
  try {
    const dir = join(harnessHome(), 'memory-tree')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'plugin.log'), `${new Date().toISOString()}\t${event}\t${fields}\n`)
  } catch {
    // Logging is diagnostics only: never let it reach the compaction path.
  }
}

/** Which build of the backend this copy of the plugin linked against. */
function basePath() {
  try {
    return import.meta.resolve('@deepseek-ai/dsh-compaction-basic')
  } catch {
    return 'unresolved'
  }
}

/** The plugin instance currently owning the prototype hook, if any. */
let active = null

/**
 * Key on a patched function pointing at the implementation it replaced.
 *
 * Cordis HMR re-imports this module on every file change, so the prototype gets
 * patched more than once per process. Without this, the second import would
 * capture the first import's wrapper as its "original" and the two would call
 * each other.
 */
const ORIGINAL = Symbol.for('@xiaob/dsh-memory-tree/original')

/** The backend's own summarize, captured before this module replaced it. */
const previous = Base.prototype.summarize
const originalSummarize = previous?.[ORIGINAL] ?? previous

if (typeof originalSummarize !== 'function') {
  record('patchfail', `error=prototype.summarize is ${typeof originalSummarize}\tbase=${basePath()}`)
} else {
  /**
   * Summarize through the memory tree, or fall back to the backend untouched.
   * `this` is whichever engine instance the backend called it on (possibly a
   * Cordis proxy), so the original is always invoked with that same receiver.
   */
  const patched = async function patchedSummarize(input, agent, signal) {
    if (active === null) return originalSummarize.call(this, input, agent, signal)
    return active.compact(this, input, agent, signal)
  }
  patched[ORIGINAL] = originalSummarize
  Base.prototype.summarize = patched
  record('import', `pid=${process.pid}\tprototype=patched\trewrapped=${previous === originalSummarize ? 'no' : 'yes'}`
    + `\tbase=${basePath()}`)
}

/** The backend's own automatic policy, captured before this module replaced it. */
const previousCompact = Base.prototype.compactIfNeeded
const originalCompactIfNeeded = previousCompact?.[ORIGINAL] ?? previousCompact

if (typeof originalCompactIfNeeded === 'function') {
  /**
   * Defer automatic pressure compaction into a background job and let the
   * current turn proceed. Overflow recovery and manual compaction still go
   * through the backend synchronously; only the ordinary "context is getting
   * full" path is off the main conversation.
   */
  const patchedCompactIfNeeded = async function patchedCompactIfNeeded(agent, trigger, signal) {
    if (active !== null) {
      try {
        if (active.defer(this, agent, trigger, signal)) return null
      } catch (error) {
        record('asyncfail', `stage=defer\terror=${reasonText(error).slice(0, 300)}`)
      }
    }
    return originalCompactIfNeeded.call(this, agent, trigger, signal)
  }
  patchedCompactIfNeeded[ORIGINAL] = originalCompactIfNeeded
  Base.prototype.compactIfNeeded = patchedCompactIfNeeded
} else {
  record('patchfail', `error=prototype.compactIfNeeded is ${typeof originalCompactIfNeeded}\tbase=${basePath()}`)
}

/** A non-empty string for anything thrown, so a log line never reads `[object Object]`. */
function reasonText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error !== '') return error
  if (error !== null && typeof error === 'object') {
    // Some adapters reject with a plain object or a provider envelope; the
    // useful sentence is usually on `.message`, and `JSON.stringify` on a
    // proxy/circular value can still yield the useless `{}`.
    if (typeof error.message === 'string' && error.message !== '') return error.message
    if (typeof error.error === 'string' && error.error !== '') return error.error
    if (typeof error.reason === 'string' && error.reason !== '') return error.reason
  }
  try {
    const json = JSON.stringify(error)
    if (typeof json === 'string' && json !== '' && json !== '{}') return json
  } catch {
    // Circular or unserializable: fall through to the constructor name.
  }
  const text = String(error)
  return text === '[object Object]' ? `${error?.constructor?.name ?? typeof error}` : text
}


/** Positive integer from the environment, else the fallback. */
function envInt(name, fallback) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** A positive integer from a profile config value, or undefined. */
function configInt(value) {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined
}

/** A non-empty string from profile config, or undefined. */
function configText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A non-negative integer from profile config, else the fallback. */
function configCount(value, fallback = 0) {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback
}

/** A non-negative integer from the environment, else the fallback. */
function envCount(name, fallback = 0) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Prompt template fields, keyed by the engine's short kind. Each has a `Zh`
 * and `En` config field.
 */
const PROMPT_FIELD_BY_KIND = Object.freeze({
  leaf: 'promptLeaf',
  leafScope: 'promptLeafScope',
  leafScopeChunk: 'promptLeafScopeChunk',
  budget: 'promptBudget',
  skeleton: 'promptSkeleton',
  parent: 'promptParent',
  retry: 'promptRetry',
})

/** Collect the configured prompt templates for both languages. */
function readPromptOverrides(config) {
  const prompts = {}
  for (const language of ['zh', 'en']) {
    const suffix = language === 'en' ? 'En' : 'Zh'
    const bundle = {}
    for (const [kind, field] of Object.entries(PROMPT_FIELD_BY_KIND)) {
      const text = config[`${field}${suffix}`]
      if (typeof text === 'string' && text.trim() !== '') bundle[kind] = text
    }
    prompts[language] = bundle
  }
  return prompts
}

/**
 * Resolved budgets.
 *
 * Defaults: 30k tokens per chunk, 12 chunks per round, a 1000-character node,
 * 8 nodes per level with 4 merged into a parent, and at most 8 merge batches
 * per round.
 *
 * Precedence is default < environment < profile config: the environment is for
 * one-off inspection, the profile patch is the deployment's declared intent.
 * @param {object} config the profile's `config:` block for this plugin.
 * @returns {object} resolved budgets.
 */
function readLimits(config = {}) {
  const spec = [
    ['chunkTokens', 'DSH_MEMORY_TREE_CHUNK_TOKENS', 30000],
    ['maxChunks', 'DSH_MEMORY_TREE_MAX_CHUNKS', 12],
    ['nodeBudget', 'DSH_MEMORY_TREE_NODE_BUDGET', 1000],
    ['mergeThreshold', 'DSH_MEMORY_TREE_MERGE_THRESHOLD', 8],
    ['branch', 'DSH_MEMORY_TREE_BRANCH', 4],
    ['maxMerges', 'DSH_MEMORY_TREE_MAX_MERGES', 8],
  ]
  const limits = {}
  for (const [key, env, fallback] of spec) {
    limits[key] = configInt(config[key]) ?? envInt(env, fallback)
  }
  // 0 = follow the backend's window-ratio policy for *when* to compact.
  // How much tail survives is always a message count, never a token budget.
  limits.triggerTokens = configCount(config['triggerTokens'], envCount('DSH_MEMORY_TREE_TRIGGER_TOKENS', 0))
  limits.retainMessages = configCount(config['retainMessages'], envCount('DSH_MEMORY_TREE_RETAIN_MESSAGES', 20))
  limits.language = configText(config['language']) === 'en' ? 'en' : 'zh'
  // Background compression is the default. `sync` is the escape hatch for
  // one-off debugging: it restores the backend's blocking behavior.
  limits.sync = config['async'] === false
    || configText(config['mode']) === 'sync'
    || process.env['DSH_MEMORY_TREE_SYNC'] === '1'
  const provider = configText(config['summaryProvider'])
  const model = configText(config['summaryModel'])
  if (provider !== undefined && model !== undefined) limits.summaryRoute = { provider, model }
  limits.prompts = readPromptOverrides(config)
  return limits
}

/** The routed model that priced this request, used when no inner call ran. */
function routeOf(agent) {
  const header = agent?.session?.requestHeader?.()?.config
  if (header !== undefined && header !== null && typeof header.provider === 'string') {
    return { provider: header.provider, model: header.model }
  }
  const options = agent?.options
  return {
    provider: String(options?.provider ?? 'memory-tree'),
    model: String(options?.model ?? 'memory-tree'),
  }
}

/**
 * Resolve the trigger against the displayed request window.
 *
 * Kept in this entry (not the policy module) because a hot reload of a
 * dependency can stay cached; the entry itself is what the Loader replaces.
 * @param {object} config engine config.
 * @param {object} header latest request header.
 * @param {object} info adapter model info.
 * @param {object} limits plugin limits.
 * @param {number} contextWindow displayed request window.
 * @returns {{thresholdTokens: number, retainMessages: number} | null} resolved budgets.
 */
function resolveSpecForWindow(config, header, info, limits, contextWindow) {
  const target = header?.config
  if (target === undefined || typeof target !== 'object') return null
  const reserved = Number(target.maxTokens ?? info?.defaultMaxTokens ?? 0)
  const messageBudget = contextWindow - reserved
  if (messageBudget <= 0) return null
  const headroom = Number(config?.headroomTokens ?? 65_536)
  const pressureBudget = messageBudget - headroom
  if (pressureBudget <= 0) return null
  const fixedTrigger = Number(limits?.triggerTokens ?? 0)
  const thresholdTokens = fixedTrigger > 0
    ? Math.min(fixedTrigger, pressureBudget)
    : Math.floor(Math.min(
      contextWindow * Number(config?.thresholdRatio ?? 0.8),
      pressureBudget,
    ))
  if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return null
  return {
    thresholdTokens,
    // Count-only retention: the tail is a message count, never a token budget.
    retainMessages: Math.max(0, Math.trunc(Number(limits?.retainMessages ?? 0))),
  }
}

/**
 * The denominator the composer percentage displays: the newest
 * `request/context` window, not the adapter's raw capacity.
 *
 * `resolveModelInfo` can report the model's full window (1.6M here while the
 * actual request context is 1.0M). Using the larger number made the trigger
 * threshold look far away from the visible percentage — the UI said 64% while
 * the plugin still compared against 45% of a different denominator.
 * @param {object} session live session.
 * @returns {number | undefined} the latest durable request window.
 */
function latestContextWindow(session) {
  if (typeof session?.seq !== 'number' || typeof session.eventAt !== 'function') return undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'request/context') {
      const value = Number(event.data?.contextWindow)
      return Number.isInteger(value) && value > 0 ? value : undefined
    }
  }
  return undefined
}

/**
 * Chat row keys a retained surface event can render as.
 *
 * The transcript keys rows with `conversationContextKey(kind, id)`, which is
 * `${kind.length}:${kind}${id}`. The card uses these keys to find the oldest
 * retained row; hiding starts immediately before it, so every uncompressed
 * message stays visible no matter what the previous page loaded.
 * @param {object | null | undefined} event durable surface event.
 * @returns {string[]} candidate `data-chat-node-key` values.
 */
function retainedRowKeys(event) {
  const data = event?.data
  if (data === null || data === undefined) return []
  if (event.type === 'user/message' && data.id !== undefined) {
    const id = String(data.id)
    // Normal input renders under `input-message`; a claimed steering input
    // renders under `steering`.
    return [`13:input-message${id}`, `8:steering${id}`]
  }
  if (event.type === 'assistant/message' && data.turn !== undefined && data.step !== undefined) {
    return [`14:assistant-step${String(data.turn)}:${String(data.step)}`]
  }
  if (event.type === 'tool/call' && data.callId !== undefined) {
    return [`9:tool-call${String(data.callId)}`]
  }
  if (event.type === 'tool/result') {
    const callId = data.message?.source?.callId
    return callId === undefined ? [] : [`9:tool-call${String(callId)}`]
  }
  if (event.type === 'system/message' && data.message?.id !== undefined) {
    return [`14:system-message${String(data.message.id)}`]
  }
  return []
}

/**
 * Chat row keys after one checkpoint's shadowed range.
 * @param {object} session live session.
 * @param {number} checkpoint seq of the replacement `user/message`.
 * @returns {string[] | null} retained keys, or null when the checkpoint cannot be read.
 */
function retainedKeysForCheckpoint(session, checkpoint) {
  const seq = Number(checkpoint)
  const summary = session?.eventAt?.(seq - 1)
  if (summary?.type !== 'compaction/summary') return null
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return null
  // The replacement is inserted at the start of the shadowed range, so every
  // surface node after it is the retained tail (plus later messages).
  const checkpointIndex = nodes.indexOf(seq)
  if (checkpointIndex < 0) return null
  const keys = []
  for (let index = checkpointIndex + 1; index < nodes.length; index += 1) {
    keys.push(...retainedRowKeys(session.eventAt(nodes[index])))
  }
  return keys
}

/**
 * Timestamps for the region being compacted, keyed by message object.
 *
 * The backend builds that region with
 * `session.deriveEventMessage(session.eventAt(seq))`, and that projection returns
 * the frozen message stored *inside* the event — the very object it then hands
 * us. So object identity is an exact index: every message we were given has a
 * log position, and every log position has an `event.time` (`dsh-session` stamps
 * `Date.now()` on append). Nothing is parsed and nothing is guessed.
 *
 * Scanning from the newest event backwards stops as soon as every message is
 * found, so a compaction pays for the region it summarizes, not for the session.
 * The floor is a guard against a message that never matches (a replayed shape
 * this build does not know): it bounds the walk instead of rescanning history.
 * @param {object} agent owning agent.
 * @param {readonly object[] | undefined} messages the region about to be summarized.
 * @returns {Map<object, number>} message -> epoch milliseconds.
 */
function messageTimes(agent, messages) {
  const times = new Map()
  const session = agent?.session
  if (!Array.isArray(messages) || messages.length === 0) return times
  if (typeof session?.seq !== 'number' || typeof session.eventAt !== 'function') return times
  const wanted = new Set(messages)
  const floor = Math.max(0, session.seq - 20000)
  for (let seq = session.seq - 1; seq >= floor && times.size < wanted.size; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === null || event === undefined) continue
    const message = deriveEventMessage(event)
    if (message === null || !wanted.has(message) || typeof event.time !== 'number') continue
    times.set(message, event.time)
  }
  return times
}

/**
 * Close a compaction that a previous process left open.
 *
 * `dsh-compaction-basic` decides whether compaction is running by scanning the
 * log backwards and stopping at the newest `compaction/start` or
 * `compaction/end`. A start whose end never landed — a crash, a kill, a reload
 * mid-run — therefore blocks every later compaction *durably*, and restarting
 * does not help: the marker is in the session log, not in memory.
 *
 * The backend writes exactly one `compaction/end` when a run fails, so writing
 * that same event is the repair, not a hack. It is skipped when the marker is
 * recent, because a compaction that is genuinely still running would look
 * identical from here.
 * @param {object} session live session.
 * @returns {void}
 */
function closeOrphanedCompaction(session) {
  const count = Number(session?.seq ?? 0)
  if (!Number.isFinite(count) || count <= 0) return
  if (typeof session.eventAt !== 'function' || typeof session.append !== 'function') return
  let open
  for (let seq = count - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === null || event === undefined) continue
    if (event.type === 'compaction/start') {
      open = event
      break
    }
    if (event.type === 'compaction/end') break
  }
  if (open === undefined) return
  const age = Date.now() - Number(open.time ?? 0)
  if (!Number.isFinite(age) || age < 60_000) return
  const data = { compactionId: open.data?.compactionId, turn: open.data?.turn ?? null }
  if (typeof open.data?.sourceCommandId === 'string') data.sourceCommandId = open.data.sourceCommandId
  session.append('compaction/end', data)
  record('repair', `session=${session.id}\tclosed orphaned compaction/start at seq=${open.seq}`
    + `\tage=${Math.round(age / 1000)}s\tcompactionId=${data.compactionId}`)
}

/** Sessions already inspected, so the repair runs once per session per process. */
const repaired = new WeakSet()

/**
 * Watch for a session becoming live and repair it once.
 *
 * The repair is deferred: `append` rejects a reentrant call, and a `session/event`
 * handler is running inside one.
 * @param {import('@deepseek-ai/cordis').Context} ctx owning context.
 * @param {object} [session] the session an event arrived for.
 * @returns {void}
 */
function scheduleRepair(ctx, session) {
  if (session === null || session === undefined || repaired.has(session)) return
  repaired.add(session)
  setImmediate(() => {
    try {
      closeOrphanedCompaction(session)
    } catch (error) {
      // A repair that cannot run must not take the session down with it.
      record('repairfail', `session=${session?.id ?? 'unknown'}\terror=${reasonText(error).slice(0, 200)}`)
    }
  })
}

/** Hierarchical summarizer for the installed compaction backend. */
export default class MemoryTreeCompaction {
  /**
   * `tools` contributes the drill-down tool; `llm` is what the compression calls
   * go through. Without `llm` this plugin cannot summarize, so it is an injection
   * rather than a lazily probed service.
   */
  static inject = ['tools', 'llm']
  static Config = Config

  _limits
  _store = null
  /** Per-session background compression job, so one session never runs two. */
  _jobs = new Map()
  /** Per-session last successful checkpoint, for the composer summary badge. */
  _last = new Map()
  /** `sessionId:checkpoint` -> Chat row keys left uncompressed. */
  _keeps = new Map()
  /** Per-session live agent/engine handles, for the status badge's context share. */
  _agents = new Map()
  _engines = new Map()
  /** Per-session retry floor after a no-op decision, to avoid pricing every step. */
  _skipUntil = new Map()

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx owning context.
   * @param {object} [config] profile `config:` block: tree budgets.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this._limits = readLimits(config ?? {})
    active = this
    try {
      registerExploreTool(ctx, () => this._tree(), this._limits)
    } catch (error) {
      // A rejected tool declaration must not take compaction down with it.
      ctx.logger?.warn?.(`memory-tree: explore_memory_tree registration failed: ${
        error instanceof Error ? error.message : String(error)}`)
    }
    const ROUTE_CLEANUP = Symbol.for('@xiaob/dsh-memory-tree/route-cleanup')
    const registerStatus = (scope) => {
      try {
        const web = scope?.get?.('webServer') ?? ctx.get?.('webServer')
        if (web?.register === undefined) return false
        // HMR can import this module again while the previous instance's exact
        // routes are still mounted; remove those first.
        const previous = globalThis[ROUTE_CLEANUP]
        try {
          if (typeof previous === 'function') previous()
          else previous?.cleanup?.()
        } catch {
          // The previous cleanup already ran.
        }
        delete globalThis[ROUTE_CLEANUP]
        const register = (path, handler) => {
          try {
            return web.register({ kind: 'exact', path, handler })
          } catch (error) {
            // A duplicate means an older instance already owns this path.
            // Its handler resolves through `active`, so it is safe to keep.
            if (/duplicate exact route/i.test(reasonText(error))) return null
            throw error
          }
        }
        const offStatus = register('/memory-tree/api/status',
          (req, res) => (active ?? this)._serveStatus(req, res))
        const offSession = register('/memory-tree/api/session',
          (req, res) => (active ?? this)._serveSession(req, res))
        const owner = Symbol('memory-tree-routes')
        globalThis[ROUTE_CLEANUP] = {
          owner,
          cleanup: () => {
            offStatus?.()
            offSession?.()
          },
        }
        ctx.effect(() => () => {
          const current = globalThis[ROUTE_CLEANUP]
          if (current?.owner !== owner) return
          try {
            current.cleanup()
          } finally {
            delete globalThis[ROUTE_CLEANUP]
          }
        }, 'memtree: routes')
        record('status-route', 'path=/memory-tree/api/status,/memory-tree/api/session')
        return true
      } catch (error) {
        record('routefail', `error=${reasonText(error).slice(0, 200)}`)
        ctx.logger?.warn?.(`memory-tree: status route unavailable: ${reasonText(error)}`)
        return false
      }
    }
    if (!registerStatus(ctx)) {
      // The HTTP server may mount after this plugin on a cold start. Retry
      // briefly instead of depending on injection order.
      record('route-wait', 'webServer not ready')
      const timer = setInterval(() => {
        if (registerStatus(ctx)) clearInterval(timer)
      }, 500)
      ctx.effect(() => () => clearInterval(timer), 'memtree: route retry')
      timer.unref?.()
    }
    ctx.effect(() => () => {
      if (active === this) active = null
      for (const job of this._jobs.values()) {
        job.controller.abort()
        if (!job.committed) this._rollback(job)
      }
      this._jobs.clear()
      this._skipUntil.clear()
      this._last.clear()
      this._keeps.clear()
      this._agents.clear()
      this._engines.clear()
      this._store?.close()
      this._store = null
    })
    // Settings writes can arrive without remounting this plugin. Re-read the
    // namespace value so a saved trigger/retain/prompt applies to the next
    // background job instead of waiting for a restart.
    try {
      ctx.on('settings/document-updated', (ns) => {
        if (String(ns) !== 'memory-tree') return
        try {
          const row = ctx.get?.('settings')?.describe?.().find(item => item.ns === 'memory-tree')
          if (row !== undefined) this._limits = readLimits(row.value ?? {})
        } catch {
          // A settings refresh miss leaves the last accepted limits in place.
        }
      })
    } catch {
      // Older profiles may not expose the settings event.
    }
    // A session that a previous process left mid-compaction would otherwise stay
    // locked for good; the first event a loaded session emits is the earliest
    // point where appending a closing marker is legal.
    try {
      ctx.on('session/event', (session, event) => {
        scheduleRepair(ctx, session)
        this._recordRetained(session, event)
      })
    } catch (error) {
      ctx.logger?.warn?.(`memory-tree: could not watch sessions for repair: ${reasonText(error)}`)
    }
    this._recordActivation()
    // This constructor runs while the fiber is still LOADING; the settings
    // service skips LOADING entries. Recompute after the fiber settles so the
    // new namespace is published to the client mirror.
    setImmediate(() => {
      try {
        this.ctx.get?.('settings')?.describe?.()
      } catch {
        // Settings is optional; compaction must still work without it.
      }
    })
  }

  /**
   * Whether one session currently opts into memory-tree compaction. A store
   * failure falls back to the framework's ordinary compaction, so it defaults
   * to disabled rather than claiming a tree the user never enabled.
   * @param {string} sessionId owning session.
   * @returns {boolean} the session's switch.
   */
  _sessionEnabled(sessionId) {
    try {
      return this._tree().sessionEnabled(sessionId)
    } catch {
      return false
    }
  }

  /**
   * Record the Chat rows a just-landed checkpoint left uncompressed.
   *
   * Both the async commit and the backend's synchronous `/compact` path publish
   * the replacement here. The summary event immediately before it states the
   * replaced range; the current surface after that range is the retained tail.
   * @param {object} session session that appended the event.
   * @param {object} event appended durable event.
   * @returns {void}
   */
  _recordRetained(session, event) {
    if (compactCheckpointSource(event) === undefined) return
    const keys = retainedKeysForCheckpoint(session, event.seq)
    if (keys === null) return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    const checkpoint = Number(event.seq)
    this._keeps.set(`${sessionId}:${checkpoint}`, keys)
    if (this._keeps.size > 200) {
      this._keeps.delete(this._keeps.keys().next().value)
    }
    try {
      this._tree().setKeep(sessionId, checkpoint, keys)
    } catch (error) {
      // The in-memory copy still serves this process; persistence is retried
      // by the next checkpoint if the database is temporarily unavailable.
      record('keepfail', `session=${sessionId}\tcheckpoint=${checkpoint}`
        + `\terror=${reasonText(error).slice(0, 200)}`)
    }
  }

  /**
   * Record that this build is live, and what it can see.
   *
   * `service=` is the diagnostic that separates the two ways this plugin can be
   * useless: `absent` means the backend is not mounted on this context at all
   * (the prototype hook still applies to whatever instance exists), while a
   * class name means this plugin and the backend linked against the same module.
   * @returns {void}
   */
  _recordActivation() {
    const service = (() => {
      try {
        return this.ctx.compaction?.constructor?.name ?? 'absent'
      } catch {
        return 'unreadable'
      }
    })()
    record('activate', `pid=${process.pid}\tservice=${service}`
      + `\tchunkTokens=${this._limits.chunkTokens}\tnodeBudget=${this._limits.nodeBudget}`
      + `\tthreshold=${this._limits.mergeThreshold}\tbranch=${this._limits.branch}`
      + `\tlang=${this._limits.language}\tmode=${this._limits.sync ? 'sync' : 'async'}\tbase=${basePath()}`
      // `self` answers "which build is actually loaded": the app imports the
      // copy under the profile's node_modules, so a stale copy runs old code
      // with a perfectly plausible log.
      + `\tself=${import.meta.url}`)
  }

  /** Lazily opened tree store. */
  _tree() {
    this._store ??= new MemoryTreeStore()
    return this._store
  }

  /**
   * Remove tree nodes from a run whose checkpoint never landed.
   * @param {{sessionId?: string, created?: string[]}} job background job record.
   * @returns {void}
   */
  _rollback(job) {
    const ids = Array.isArray(job?.created) ? job.created : []
    if (ids.length === 0 || typeof job?.sessionId !== 'string') return
    try {
      this._tree().rollback(job.sessionId, ids)
      record('async-rollback', `session=${job.sessionId}\tnodes=${ids.length}`)
    } catch (error) {
      record('asyncfail', `stage=rollback\terror=${reasonText(error).slice(0, 200)}`)
    }
    job.created.length = 0
  }

  /**
   * Project one summarizer event onto the job that the status badge polls.
   * @param {object | undefined} job background job, absent for sync calls.
   * @param {string} kind event kind (`start`, `leaf`, `merge`, ...).
   * @param {string} detail tab-separated detail line.
   * @returns {void}
   */
  _noteJob(job, kind, detail) {
    if (job === undefined || job === null) return
    if (kind === 'start') {
      const chunks = /chunks=(\d+)/.exec(String(detail))
      job.total = chunks === null ? job.total : Number(chunks[1])
      job.phase = 'summarizing'
      job.progress = job.total > 0 ? `0/${job.total} 片` : '准备分片'
      return
    }
    if (kind === 'leaf') {
      const match = /n=(\d+)\/(\d+)/.exec(String(detail))
      if (match !== null) {
        job.leaves = Number(match[1])
        job.total = Number(match[2])
        job.progress = `${job.leaves}/${job.total} 片`
      } else {
        job.progress = '摘要分片'
      }
      job.phase = 'summarizing'
      return
    }
    if (kind === 'merge') {
      job.phase = 'merging'
      job.progress = String(detail).includes('parents=') ? String(detail) : '合并父节点'
    }
  }

  /**
   * Serve the in-memory background-job snapshot for the composer badge.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @returns {void}
   */
  _serveStatus(req, res) {
    let session = ''
    let compaction = NaN
    try {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      session = params.get('session') ?? ''
      compaction = Number(params.get('compaction') ?? '')
    } catch {
      session = ''
    }
    const jobs = [...this._jobs.values()]
      .filter(job => session === '' || job.sessionId === session)
      .map(job => ({
        sessionId: job.sessionId,
        phase: job.phase,
        progress: job.progress,
        leaves: job.leaves,
        total: job.total,
        shadowed: job.shadowed ?? 0,
        error: job.error ?? '',
        startedAt: job.startedAt,
      }))
    let live = null
    if (session !== '' && this._agents.has(session)) {
      try {
        const agent = this._agents.get(session)
        const engine = this._engines.get(session)
        const roots = this._tree().roots(session)
        const stats = this._tree().stats(session)
        const text = renderNodeBlocks({ roots, stats }).join('\n')
        const measured = engine.ctx.tokenMeter.measure(agent.session, agent.session.requestHeader())
        live = {
          summaryTokens: Math.ceil(text.length / 4) + 8,
          usedTokens: Number(measured.totalTokens) || 0,
          contextWindow: Number(latestContextWindow(agent.session)) || 0,
        }
      } catch {
        live = null
      }
    }
    let keep = null
    if (Number.isSafeInteger(compaction)) {
      if (session !== '') {
        keep = this._keeps.get(`${session}:${compaction}`) ?? null
        if (keep === null) {
          try {
            keep = this._tree().getKeep(session, compaction)
          } catch {
            keep = null
          }
        }
      } else {
        keep = this._keeps.get(compaction) ?? null
      }
    }
    if (keep === null && session !== '' && Number.isSafeInteger(compaction)) {
      try {
        const liveSession = this.ctx.get?.('sessions')?.get?.(session)
        const keys = liveSession === undefined
          ? null
          : retainedKeysForCheckpoint(liveSession, compaction)
        if (keys !== null) {
          keep = keys
          this._keeps.set(`${session}:${compaction}`, keys)
          try {
            this._tree().setKeep(session, compaction, keys)
          } catch {
            // The live answer still serves this request; the next checkpoint
            // retries persistence.
          }
        }
      } catch {
        // A missing or disposed session leaves the keep set unknown; the card
        // then shows history instead of risking a hidden retained message.
      }
    }
    const body = JSON.stringify({
      jobs,
      last: session === '' ? null : this._last.get(session) ?? null,
      live,
      keep,
      enabled: session === '' ? false : this._sessionEnabled(session),
    })
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /**
   * Persist one session's memory-tree switch.
   *
   * Turning it off aborts a running background job; its catch path rolls the
   * uncommitted nodes back. The next pressure trigger then falls through to the
   * backend's ordinary compaction.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @returns {void}
   */
  _serveSession(req, res) {
    let session = ''
    try {
      session = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session') ?? ''
    } catch {
      session = ''
    }
    const fail = (status, text) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
    }
    if (req.method !== 'POST') return fail(405, 'method not allowed')
    if (session === '') return fail(400, 'missing session')
    let raw = ''
    req.setEncoding?.('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4096) req.destroy()
    })
    req.on('end', () => {
      try {
        const data = JSON.parse(raw === '' ? '{}' : raw)
        if (typeof data.enabled !== 'boolean') {
          fail(400, 'enabled must be a boolean')
          return
        }
        this._tree().setSessionEnabled(session, data.enabled)
        if (!data.enabled) this._jobs.get(session)?.controller.abort()
        record('session-switch', `session=${session}\tenabled=${String(data.enabled)}`)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ session, enabled: data.enabled }))
      } catch (error) {
        fail(400, `invalid request: ${reasonText(error).slice(0, 120)}`)
      }
    })
  }

  /**
   * Start a background compression job and return immediately.
   *
   * The backend calls this from `agent/pre-step` and would otherwise await the
   * whole summarization before the next model request. Returning `true` tells
   * the prototype wrapper to answer `null`, so the turn proceeds while the tree
   * grows on the side.
   * @param {object} engine the compaction engine receiving the call.
   * @param {object} agent owning agent.
   * @param {string} trigger `pressure` or `context-overflow`.
   * @param {AbortSignal} [signal] the turn's cancellation signal.
   * @returns {boolean} whether the call was deferred.
   */
  defer(engine, agent, trigger, signal) {
    if (this._limits.sync || trigger !== 'pressure') return false
    if (signal?.aborted === true) return false
    const sessionId = String(agent?.session?.id ?? '')
    if (sessionId === '') return false
    // Off means "use the backend's ordinary compaction", not "never compact".
    // Returning false lets the original compactIfNeeded run synchronously.
    if (!this._sessionEnabled(sessionId)) {
      record('session-off', `session=${sessionId}\tmode=async`)
      return false
    }
    this._agents.set(sessionId, agent)
    this._engines.set(sessionId, engine)
    if (this._jobs.has(sessionId)) return true
    if ((this._skipUntil.get(sessionId) ?? 0) > Date.now()) return true
    const job = {
      sessionId,
      controller: new AbortController(),
      created: [],
      committed: false,
      phase: 'queued',
      progress: '准备压缩',
      leaves: 0,
      total: 0,
      startedAt: Date.now(),
    }
    this._jobs.set(sessionId, job)
    record('async-start', `session=${sessionId}\tjob=${randomUUID()}`)
    Promise.resolve()
      .then(() => this._runBackground(engine, agent, job))
      .catch((error) => {
        if (!job.committed) this._rollback(job)
        const message = reasonText(error).replace(/[\t\r\n]+/g, ' ').slice(0, 300)
        job.phase = 'failed'
        job.error = message
        record('asyncfail', `session=${sessionId}\terror=${message}`)
        this.ctx?.logger?.warn?.(`memory-tree: background compaction failed: ${message}`)
      })
      .finally(() => {
        // Keep the terminal snapshot visible to the badge for a few seconds;
        // it also keeps a second job from starting during that window.
        setTimeout(() => {
          if (this._jobs.get(sessionId) === job) this._jobs.delete(sessionId)
        }, 6_000)
      })
    return true
  }

  /**
   * Snapshot the range, summarize it, and commit when the turn is over.
   * @param {object} engine compaction engine.
   * @param {object} agent owning agent.
   * @param {object} job job record.
   * @returns {Promise<void>} resolves after commit or a no-op decision.
   */
  async _runBackground(engine, agent, job) {
    const session = agent.session
    const signal = job.controller.signal
    if (!this._sessionEnabled(String(session.id))) {
      job.phase = 'skipped'
      job.progress = '本会话已关闭记忆树'
      return
    }
    const header = session.requestHeader()
    if (header === undefined || header === null) return
    const info = await engine.ctx.llm.resolveModelInfo(
      header.config.provider, header.config.model, signal,
    )
    // Prefer the same denominator the composer percentage renders: the latest
    // request/context window. The adapter's raw capacity can be larger.
    const contextWindow = latestContextWindow(session)
    const spec = contextWindow === undefined
      ? resolveSpec(engine.config, header, info, this._limits)
      : resolveSpecForWindow(engine.config, header, info, this._limits, contextWindow)
    if (spec === null) {
      this._skipUntil.set(job.sessionId, Date.now() + 60_000)
      job.phase = 'skipped'
      job.progress = '模型窗口不可用'
      record('asyncskip', `session=${job.sessionId}\treason=cannot-price-model`)
      return
    }
    let measurement = engine.ctx.tokenMeter.measure(session, header)
    const usedTokens = measurement.totalTokens
    if (usedTokens < spec.thresholdTokens) {
      this._skipUntil.set(job.sessionId, Date.now() + 10_000)
      job.phase = 'skipped'
      job.progress = `未达阈值 ${usedTokens}/${spec.thresholdTokens}`
      record('asyncskip', `session=${job.sessionId}\treason=below-threshold`
        + `\ttokens=${usedTokens}\tthreshold=${spec.thresholdTokens}`
        + `\tmeasure=${measurement.totalTokens}`
        + `\twindow=${contextWindow ?? 'unknown'}`)
      return
    }
    let range = selectRange(
      session,
      measurement,
      spec.retainMessages ?? this._limits.retainMessages ?? 20,
      toolPairingBalancedBefore,
    )
    if (range === null) {
      this._skipUntil.set(job.sessionId, Date.now() + 30_000)
      job.phase = 'skipped'
      job.progress = '没有安全的压缩区间'
      record('asyncskip', `session=${job.sessionId}\treason=no-safe-range`)
      return
    }
    const surface = session.surface.nodes
    let seqs = surface.slice(range.startIdx, range.endIdx + 1)
    let priced = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
    let shadowedTokenCount = priced.reduce(
      (total, node) => total + Number(node.heuristicTokens ?? 0), 0,
    )
    let shadowedRouteTokenCount = priced.reduce(
      (total, node) => total + Number(node.tokens ?? 0), 0,
    )
    const input = buildInput(session, seqs)
    const route = this._limits.summaryRoute
      ?? { provider: header.config.provider, model: header.config.model }
    job.phase = 'summarizing'
    job.progress = '准备分片'
    const result = await this._summarize(agent, input, signal, route, job.created, 'async', job)
    if (signal.aborted) {
      if (!job.committed) this._rollback(job)
      return
    }
    // A full chunk cap leaves the newest messages unsummarized. Shrink the
    // replacement to the summarized prefix; the rest is the verbatim tail the
    // user expects to keep seeing.
    const covered = Math.max(1, Math.min(seqs.length, Number(result.covered) || seqs.length))
    if (covered < seqs.length) {
      seqs = seqs.slice(0, covered)
      range = { ...range, end: seqs[covered - 1], endIdx: range.startIdx + covered - 1 }
      priced = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
      shadowedTokenCount = priced.reduce(
        (total, node) => total + Number(node.heuristicTokens ?? 0), 0,
      )
      shadowedRouteTokenCount = priced.reduce(
        (total, node) => total + Number(node.tokens ?? 0), 0,
      )
      record('partial', `session=${job.sessionId}\tselected=${range.endIdx - range.startIdx + 1}`
        + `\tcovered=${covered}\tkept-tail=${surface.length - range.endIdx - 1}`)
    }
    job.phase = 'waiting-idle'
    job.progress = `已压 ${result.leaves} 片 · 等待空闲提交`
    const prepared = {
      engine,
      agent,
      sessionId: job.sessionId,
      range,
      seqs,
      shadowedTokenCount,
      shadowedRouteTokenCount,
      blocks: result.blocks,
      route,
      created: job.created,
      signal,
      job,
    }
    try {
      await this._commitWhenIdle(agent, prepared)
    } finally {
      job.committed = prepared.committed === true
      if (job.committed) this._skipUntil.delete(job.sessionId)
    }
  }

  /**
   * Wait for the turn to close, then claim one idle maintenance slot for the
   * fast, model-free commit.
   * @param {object} agent owning agent.
   * @param {object} prepared summary and range to commit.
   * @returns {Promise<void>} resolves after the checkpoint lands.
   */
  async _commitWhenIdle(agent, prepared) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      prepared.signal?.throwIfAborted?.()
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => {
          const signal = prepared.signal
          if (signal === undefined) return
          if (signal.aborted) {
            reject(signal.reason ?? new Error('background compaction aborted'))
            return
          }
          signal.addEventListener('abort', () => {
            reject(signal.reason ?? new Error('background compaction aborted'))
          }, { once: true })
        }),
      ])
      let entered = false
      try {
        await agent.runMaintenance(async (signal) => {
          entered = true
          await this._commit(prepared, signal)
        })
        return
      } catch (error) {
        if (entered) throw error
        // `runMaintenance` throws synchronously when a waking input claimed the
        // idle phase between `whenIdle()` and the call; wait for the next one.
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    throw new Error('background compaction could not acquire an idle maintenance slot')
  }

  /**
   * Append the compaction transaction for a prepared summary.
   *
   * This mirrors the manual-compaction sequence in the backend: the durable
   * `compaction/start` is the lock, the summary event records the range, the
   * replacement user message shadows the span, and one `compaction/end` closes
   * the attempt.
   * @param {object} prepared background result.
   * @param {AbortSignal} signal maintenance cancellation.
   * @returns {Promise<void>} resolves after the closing event.
   */
  async _commit(prepared, signal) {
    signal?.throwIfAborted?.()
    const {
      engine, agent, sessionId, range, seqs,
      shadowedTokenCount, shadowedRouteTokenCount, blocks, route, job,
    } = prepared
    if (job !== undefined && job !== null) {
      job.phase = 'committing'
      job.progress = '写入记忆卡片'
    }
    const session = agent.session
    const surface = session.surface.nodes
    const startIdx = surface.indexOf(range.start)
    const endIdx = surface.indexOf(range.end)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      throw new Error('background compaction: selected range is no longer on the surface')
    }
    if (!sameSeqs(surface.slice(startIdx, endIdx + 1), seqs)) {
      throw new Error('background compaction: selected span changed before commit')
    }
    if (!toolPairingBalancedBefore(session, range.start)) {
      throw new Error('background compaction: start boundary would split a tool pair')
    }
    if (!toolPairingBalancedAfter(session, range.end)) {
      throw new Error('background compaction: end boundary would split a tool pair')
    }
    const locks = inspectIdle(session)
    if (locks.openTurn !== null) {
      throw new Error('background compaction: a turn opened before commit')
    }
    if (locks.unmatched !== undefined) {
      throw new Error('background compaction: another compaction transaction is active')
    }

    const compactionId = CompactionId(randomUUID())
    const lifecycle = { compactionId, turn: null }
    let opened = false
    let closed = false
    try {
      const startEvent = session.append('compaction/start', lifecycle)
      opened = true
      let useBlocks = blocks
      let message = createUserMessage({
        content: frameBlocks(useBlocks),
        source: compactCheckpointSource(compactionId),
      })
      let framedTokens = engine.ctx.tokenMeter.estimateMessage(message)
      if (framedTokens >= shadowedRouteTokenCount) {
        const roots = this._tree().roots(sessionId)
        const stats = this._tree().stats(sessionId)
        useBlocks = renderNodeBlocks({ roots, stats, summaryOnly: true })
        message = createUserMessage({
          content: frameBlocks(useBlocks),
          source: compactCheckpointSource(compactionId),
        })
        framedTokens = engine.ctx.tokenMeter.estimateMessage(message)
      }
      if (framedTokens >= shadowedRouteTokenCount) {
        throw new Error('background compaction: framed summary is not smaller than the shadowed span')
      }
      const summaryEvent = session.append('compaction/summary', {
        compactionId,
        summary: useBlocks.map(text => ({ type: 'text', text })),
        shadowedRange: { start: range.start, end: range.end },
        shadowedSeqs: [...seqs],
        shadowedTokenCount,
        provider: route.provider,
        model: route.model,
      })
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...seqs],
      })
      // The replacement landed: from here on the tree must NOT be rolled back
      // even if closing the bracket or the durability checkpoint fails.
      prepared.committed = true
      session.append('compaction/end', lifecycle)
      closed = true
      if (job !== undefined && job !== null) {
        job.phase = 'done'
        job.progress = '压缩完成'
        job.shadowed = shadowedTokenCount
        job.checkpointTokens = framedTokens
      }
      try {
        const header = session.requestHeader()
        const measured = engine.ctx.tokenMeter.measure(session, header)
        this._last.set(sessionId, {
          compactionId,
          checkpointTokens: framedTokens,
          shadowedTokenCount,
          usedTokens: Number(measured.totalTokens) || 0,
          at: Date.now(),
        })
      } catch {
        this._last.set(sessionId, {
          compactionId,
          checkpointTokens: framedTokens,
          shadowedTokenCount,
          usedTokens: 0,
          at: Date.now(),
        })
      }
      record('async-commit', `session=${sessionId}\trange=${range.start}-${range.end}`
        + `\tseqs=${seqs.length}\ttokens=${framedTokens}\tshadowed=${shadowedRouteTokenCount}`)
    } catch (error) {
      if (job !== undefined && job !== null) {
        job.phase = 'failed'
        job.error = reasonText(error).slice(0, 300)
        job.progress = '提交失败'
      }
      if (opened && !closed) {
        try {
          session.append('compaction/end', {
            ...lifecycle,
            error: reasonText(error).slice(0, 300),
          })
        } catch {
          // A failed close is itself diagnostic; the original error wins.
        }
      }
      throw error
    }
  }

  /**
   * Run one tree summarization call and record its outcome.
   * @param {object} agent owning agent.
   * @param {{messages?: readonly object[], tools?: readonly object[]}} input replayed region.
   * @param {AbortSignal} [signal] cancellation.
   * @param {{provider: string, model: string}} route summary model.
   * @param {string[]} created receives every tree node id this run writes.
   * @param {'sync' | 'async'} mode diagnostic label.
   * @returns {Promise<object>} the tree result.
   */
  async _summarize(agent, input, signal, route, created, mode, job) {
    const session = String(agent?.session?.id ?? 'unknown')
    const complete = createCompleter({ ctx: this.ctx, route, sessionId: session })
    // The one line that says the hook fired at all and what it was handed. The
    // region arrives as replayed messages; its tool schemas are deliberately
    // not forwarded to the compression call, so a model cannot answer with a
    // tool call instead of the node JSON.
    const times = messageTimes(agent, input?.messages)
    record('probe', `session=${session}\tmode=${mode}\troute=${route.provider}/${route.model}`
      + `\tmessages=${Array.isArray(input?.messages) ? input.messages.length : 0}`
      + `\ttools=${Array.isArray(input?.tools) ? input.tools.length : 0} (not forwarded)`
      + `\ttimed=${times.size}`
      + `\taborted=${signal?.aborted === true}`)
    const result = await compactIntoTree({
      store: this._tree(),
      limits: this._limits,
      input,
      agent,
      signal,
      times,
      complete,
      sessionId: session,
      language: this._limits.language,
      onEvent: (kind, detail) => {
        this._noteJob(job, kind, detail)
        record(kind, `session=${session}\tmode=${mode}\t${detail}`)
      },
      onNodeId: (id) => created.push(id),
    })
    const stats = this._tree().stats(session)
    record('compact', `session=${session}\tmode=${mode}`
      + `\tleaves=${result.leaves}\tmerges=${result.merges}\tnodes=${stats.active}`
      + `\tdepth=L${Math.max(0, stats.depth)}\tblocks=${result.blocks.length}\tchars=${result.chars}`)
    return result
  }

  /**
   * Summarize the shadowed region into tree nodes and return the outline.
   *
   * Any failure degrades to the backend's own flat summarizer: a broken memory
   * tree must never prevent the session from compacting. This path serves
   * manual `/compact`, overflow recovery, and explicit region compaction; the
   * ordinary pressure trigger is deferred by `defer()` instead.
   * @param {object} receiver the engine instance the backend called through.
   * @param {{messages?: readonly object[], tools?: readonly object[]}} input replayed region.
   * @param {object} agent owning agent.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<object>} the summary result recorded in the checkpoint.
   */
  async compact(receiver, input, agent, signal) {
    const callOriginal = (chunkInput, chunkAgent, chunkSignal) =>
      originalSummarize.call(receiver, chunkInput, chunkAgent, chunkSignal)
    if (process.env['DSH_MEMORY_TREE_DISABLED'] === '1') return callOriginal(input, agent, signal)
    const session = String(agent?.session?.id ?? 'unknown')
    if (!this._sessionEnabled(session)) {
      record('session-off', `session=${session}\tmode=sync`)
      return callOriginal(input, agent, signal)
    }
    const created = []
    try {
      const route = this._limits.summaryRoute ?? routeOf(agent)
      const result = await this._summarize(agent, input, signal, route, created, 'sync')
      return {
        summary: result.blocks.map(text => ({ type: 'text', text })),
        provider: route.provider,
        model: route.model,
      }
    } catch (error) {
      if (created.length > 0) this._rollback({ sessionId: session, created })
      const message = reasonText(error)
      // A fallback is invisible by design — the session still compacts — so it
      // is recorded, or a broken tree looks exactly like a working one.
      record('fallback', `session=${session}`
        + `\terror=${message.replace(/[\t\r\n]+/g, ' ').slice(0, 300)}`)
      this.ctx?.logger?.warn?.(`memory-tree: ${message}; falling back to a flat summary`)
      if (process.env['DSH_MEMORY_TREE_DEBUG'] === '1') {
        console.error('[memory-tree] failed:', error)
      }
      // A cancelled compaction cannot be rescued by another model call, and the
      // backend rethrows an abort verbatim anyway — so do not pay for that call.
      if (signal?.aborted === true) throw error
      return callOriginal(input, agent, signal)
    }
  }
}
