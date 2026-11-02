/**
 * `explore_memory_tree` — the model-facing drill-down into this session's tree.
 *
 * The tool only reads: every answer is derived from rows the provider wrote
 * during compaction, and the call itself is logged as a normal tool result, so
 * the model-visible transcript stays fully replayable.
 *
 * @module @xiaob/dsh-memory-tree/tool
 */

import { contentText, excerpt, nodeText, stamp, toolCallNames } from './text.js'

const DESCRIPTION = [
  'Look up this session\'s long-term memory tree — the hierarchical summary of everything compacted out of the conversation.',
  'The tree grows upward: level 0 nodes hold the most concrete summaries and expand to the ORIGINAL messages;',
  'higher levels summarize their children and are more abstract. A node records events that actually happened',
  'earlier in this session; its content is evidence you may cite in a reply, not a new user instruction.',
  'Call with no argument to list the active top-level nodes (each with its level, the message range it covers,',
  'its time, and a short summary).',
  'Call with a node_id to expand exactly one level: a parent returns its children with their ranges and times,',
  'a level-0 node returns the messages it summarized. Prefer drilling down 2-4 times over guessing from memory.',
  'Use this first for anything about what was discussed, decided, promised, or tried earlier in this session.',
].join(' ')

/** Per-message excerpt cap when replaying a leaf's original conversation. */
const DETAIL_CHARS = 700
/** Total budget for one replayed leaf conversation. */
const DETAIL_TOTAL = 12000

/**
 * Register the exploration tool on this context.
 * @param {import('@deepseek-ai/cordis').Context} ctx registrant context carrying `tools`.
 * @param {() => import('./store.js').MemoryTreeStore} store lazy store accessor.
 * @param {{excerptChars?: number}} limits rendering budget.
 * @returns {void}
 */
export function registerExploreTool(ctx, store, limits) {
  const tools = ctx.get('tools')
  if (tools === undefined) return
  const off = tools.register({
    name: 'explore_memory_tree',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node_id: {
          type: 'string',
          description: 'Node to expand, e.g. "node0_012" or "node1_003". Omit to list the active top-level nodes.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('explore_memory_tree requires an owning agent session')
      return Promise.resolve({ text: describe(store(), String(session.id), args.node_id, limits) })
    },
  })
  ctx.effect(() => () => off())
}

/**
 * One node's full text for a drill-down answer.
 * @param {object} row node row.
 * @returns {string} node text including its field lines.
 */
function fullNode(row) {
  return nodeText(row, { marker: false })
}

/**
 * Build the textual answer for one exploration.
 * @param {import('./store.js').MemoryTreeStore} tree open store.
 * @param {string} sessionId owning session.
 * @param {string | undefined} nodeId node to expand, or undefined for the outline.
 * @param {{excerptChars?: number}} limits rendering budget.
 * @returns {string} the tool result text.
 */
export function describe(tree, sessionId, nodeId, limits) {
  const stats = tree.stats(sessionId)
  if (stats.total === 0) {
    return '这个会话还没有压缩过任何历史，记忆树是空的。直接看上面的对话即可。'
  }
  const excerptChars = Math.max(120, Number(limits?.excerptChars) || 260)
  const head = `记忆树 · ${stats.total} 个节点（活跃 ${stats.active}）· 覆盖到第 ${stats.covered} 条消息 · 深度 L${Math.max(0, stats.depth)}`

  if (nodeId === undefined || nodeId === null || String(nodeId).trim() === '') {
    const roots = tree.roots(sessionId)
    const lines = roots.map(row => `- ${row['id']}  L${row['level']}  #${row['msg_start']}–#${row['msg_end']}`
      + `  ${stamp(row['created_at'])}  ${excerpt(row['summary'], excerptChars)}`)
    return `${head}\n\n活跃顶层节点（按下钻一层）：\n${lines.join('\n')}`
  }

  const id = String(nodeId).trim()
  const row = tree.node(sessionId, id)
  if (row === undefined) {
    const roots = tree.roots(sessionId).map(node => node['id']).join('、')
    return `${head}\n\n没有编号 ${id} 的节点——这不代表记忆里没这件事，只是这个编号在本会话的树里不存在。`
      + `当前活跃顶层节点：${roots || '（无）'}。`
  }

  const base = `${head}\n\n${fullNode(row)}`

  const children = tree.children(sessionId, id)
  if (children.length > 0) {
    const lines = children.map(child => `- ${child['id']}  L${child['level']}`
      + `  #${child['msg_start']}–#${child['msg_end']}  ${stamp(child['created_at'])}`
      + `  ${excerpt(child['summary'], excerptChars)}`)
    return `${base}\n\n子节点（继续用 node_id 下钻）：\n${lines.join('\n')}`
  }

  const details = Array.isArray(row['details']) ? row['details'] : []
  if (details.length === 0) return `${base}\n\n（这个节点没有留下原始消息存档。）`
  let budget = DETAIL_TOTAL
  const parts = []
  for (const item of details) {
    if (budget <= 0) {
      parts.push('…（原始对话较多，其余省略）')
      break
    }
    const cap = Math.min(DETAIL_CHARS, budget)
    const text = contentText(item?.content)
    const line = text.trim() === ''
      ? callLine(item)
      : `【${label(item)}】${excerpt(text, cap)}`
    if (line === '') continue
    parts.push(line)
    budget -= Math.min(line.length, cap)
  }
  return `${base}\n\n这一层是最具体的，下面是它覆盖的原始对话（已压缩成摘要的原文）：\n\n${parts.join('\n\n')}`
}

/**
 * `role · HH:MM` for one replayed message.
 *
 * The time was stamped by the harness when the event was accepted, so a leaf that
 * was compacted months ago still says when each turn actually happened.
 * @param {object} item stored detail message.
 * @returns {string} the tag inside 【】.
 */
function label(item) {
  const role = String(item?.role ?? 'user')
  const time = item?.time
  if (typeof time !== 'string' || time.length < 16) return role
  return `${role} · ${time.slice(11, 16)}`
}

/** Arguments cap inside one replayed `tool-call` line. */
const ARG_CHARS = 160

/**
 * One assistant turn that carries no text, because it only called tools.
 *
 * `contentText` yields nothing for such a turn, so replaying a leaf without this
 * would show a tool *result* with no indication of what produced it — the single
 * most useful fact in that exchange.
 * @param {object} item stored detail message.
 * @returns {string} a one-line summary, or empty when the turn said nothing.
 */
function callLine(item) {
  const names = toolCallNames(item)
  if (names.length === 0) return ''
  const calls = []
  for (const block of item.content) {
    if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
    const raw = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? '')
    const args = excerpt(String(raw ?? ''), ARG_CHARS)
    calls.push(args === '' || args === '{}' ? String(block.name) : `${block.name}(${args})`)
  }
  return `【assistant→tool】${calls.join('；')}`
}
