/**
 * The node payload planner calls `MemoryNodeOutput`: summary plus six task
 * fields, stored as `meta.fields` and rendered back into the checkpoint.
 *
 * Two things here are load-bearing and copied from planner rather than
 * invented: the exact field set (it is what the prompt asks for, so anything
 * else silently disappears), and `applyBudget`, which enforces a total the
 * model routinely overshoots by 3-5x.
 *
 * @module @xiaob/dsh-memory-tree/schema
 */

/** Node schema version; 2 = task fields in `meta.fields`. */
export const SCHEMA_VERSION = 2

/**
 * Protective marker carried by node text that is already summarized.
 * planner puts it on every node message in the buffer; the compressor removes
 * it from the nodes it is about to merge, so "marked" literally means "leave
 * this one alone".
 */
export const NODE_MARKER = '[已压缩 · 不需要压缩]'

/** @returns {object} an all-empty fields payload. */
export function emptyFields() {
  return {
    narration: '',
    task: { goal: '', status: '', todo: [], next_steps: [], blockers: [] },
    decisions: [],
    lessons: { errors: [], patterns: [] },
    context: { cwd: '', env: [], commands: [], artifacts: [], constraints: [] },
    user: [],
  }
}

/** Trimmed string; numbers and booleans stringify the way pydantic coerces them. */
function str(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Array of trimmed non-empty strings. */
function strs(value) {
  return Array.isArray(value) ? value.map(str).filter(text => text !== '') : []
}

/** Coerce one object field, ignoring non-objects. */
function obj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Normalize a model's JSON into the fields payload.
 *
 * Unknown keys are dropped, wrong types degrade to empty rather than throwing:
 * a summary that is 90% right is still worth landing, and planner makes the same
 * trade (pydantic `extra="ignore"` plus defaults on every field).
 * @param {unknown} raw parsed JSON, or anything close to it.
 * @returns {object} normalized fields.
 */
export function coerceFields(raw) {
  const input = obj(raw)
  const task = obj(input['task'])
  const lessons = obj(input['lessons'])
  const context = obj(input['context'])
  const decisions = Array.isArray(input['decisions']) ? input['decisions'] : []
  const errors = Array.isArray(lessons['errors']) ? lessons['errors'] : []
  return {
    narration: str(input['narration']),
    task: {
      goal: str(task['goal']),
      status: str(task['status']),
      todo: strs(task['todo']),
      next_steps: strs(task['next_steps']),
      blockers: strs(task['blockers']),
    },
    decisions: decisions
      .map(item => ({ what: str(obj(item)['what']), why: str(obj(item)['why']) }))
      .filter(item => item.what !== '' || item.why !== ''),
    lessons: {
      errors: errors
        .map(item => ({
          symptom: str(obj(item)['symptom']),
          cause: str(obj(item)['cause']),
          fix: str(obj(item)['fix']),
        }))
        .filter(item => item.symptom !== '' || item.cause !== '' || item.fix !== ''),
      patterns: strs(lessons['patterns']),
    },
    context: {
      cwd: str(context['cwd']),
      env: strs(context['env']),
      commands: strs(context['commands']),
      artifacts: strs(context['artifacts']),
      constraints: strs(context['constraints']),
    },
    user: strs(input['user']),
  }
}

/** Clip every list to `n` items of at most `width` characters. */
function clip(items, n = 8, width = 200) {
  return items.slice(0, n).map(text => text.slice(0, width))
}

/** Character total the budget is measured against (summary excluded here). */
function fieldChars(fields) {
  const { task, lessons, context, decisions, user } = fields
  let total = task.goal.length + task.status.length
  for (const list of [task.todo, task.next_steps, task.blockers,
    context.env, context.commands, context.artifacts, context.constraints,
    lessons.patterns, user]) {
    for (const item of list) total += item.length
  }
  for (const decision of decisions) total += decision.what.length + decision.why.length
  for (const error of lessons.errors) {
    total += error.symptom.length + error.cause.length + error.fix.length
  }
  return total
}

/**
 * Enforce planner's node budget.
 *
 * `budget` is the whole-node character target (1000 by default). The prompt says
 * it, and this makes it true: summary is capped at 60%, each list is width- and
 * count-limited, and if the total still exceeds 1.1x the budget, whole groups are
 * sacrificed from least to most critical (`constraints` and `decisions` last).
 *
 * @param {{summary: string, fields: object}} out model output.
 * @param {number} budget whole-node character budget.
 * @returns {{summary: string, fields: object}} the same object, clipped in place.
 */
export function applyBudget(out, budget) {
  const limitBudget = Math.max(200, Math.trunc(Number(budget) || 1000))
  const summaryCap = Math.max(150, Math.trunc(limitBudget * 0.6))
  if (out.summary.length > summaryCap) {
    out.summary = out.summary.slice(0, summaryCap).replace(/\s+$/, '') + '…'
  }
  const fields = out.fields
  // The narration is a deliberately fixed-length "how I'd tell a human" line; it
  // is short enough to be noise against the total, so it never participates in
  // the group sacrifice (planner made the same call after watching it get wiped).
  fields.narration = fields.narration.slice(0, 80)
  const task = fields.task
  task.goal = task.goal.slice(0, 300)
  task.status = task.status.slice(0, 300)
  task.todo = clip(task.todo)
  task.next_steps = clip(task.next_steps)
  task.blockers = clip(task.blockers)
  fields.decisions = fields.decisions.slice(0, 8)
    .map(item => ({ what: item.what.slice(0, 200), why: item.why.slice(0, 300) }))
  fields.lessons.errors = fields.lessons.errors.slice(0, 8).map(item => ({
    symptom: item.symptom.slice(0, 200),
    cause: item.cause.slice(0, 200),
    fix: item.fix.slice(0, 300),
  }))
  fields.lessons.patterns = clip(fields.lessons.patterns)
  const context = fields.context
  context.cwd = context.cwd.slice(0, 300)
  context.env = clip(context.env)
  context.commands = clip(context.commands)
  context.artifacts = clip(context.artifacts)
  context.constraints = clip(context.constraints)
  fields.user = clip(fields.user, 12)

  const total = () => out.summary.length + fieldChars(fields)
  const limit = Math.trunc(limitBudget * 1.1)
  // Least critical first; a group is drained completely before the next is touched
  // so `constraints`/`decisions`/`lessons` survive as long as possible.
  const groups = [context.env, context.commands, context.artifacts,
    fields.lessons.patterns, task.next_steps, task.blockers, fields.user, task.todo,
    fields.decisions, fields.lessons.errors, context.constraints]
  let current = total()
  while (current > limit) {
    let progressed = false
    for (const list of groups) {
      if (current <= limit) break
      while (list.length > 0 && current > limit) {
        list.pop()
        progressed = true
        current = total()
      }
    }
    if (!progressed) break
  }
  if (current > limit) {
    const over = current - limit
    const keep = Math.max(120, out.summary.length - over - 1)
    out.summary = `${out.summary.slice(0, keep).replace(/\s+$/, '')}…`
  }
  return out
}

/**
 * Render the payload as planner's node lines: one labelled line per non-empty
 * group, empty groups omitted entirely (never "无 / 暂无" placeholders).
 * @param {object} fields fields payload.
 * @returns {string[]} lines, no trailing newline.
 */
export function renderFieldsLines(fields) {
  const lines = []
  if (fields.narration !== '') lines.push(`[概述] ${fields.narration}`)

  const task = fields.task
  const parts = []
  if (task.goal !== '') parts.push(`目标：${task.goal}`)
  if (task.status !== '') parts.push(`状态：${task.status}`)
  if (task.todo.length > 0) parts.push(`待办：${task.todo.join('、')}`)
  if (task.next_steps.length > 0) parts.push(`下一步：${task.next_steps.join('、')}`)
  if (task.blockers.length > 0) parts.push(`阻塞：${task.blockers.join('、')}`)
  if (parts.length > 0) lines.push(`[任务] ${parts.join('；')}`)

  const decisions = fields.decisions
    .map(item => (item.why !== '' ? `${item.what}（因为 ${item.why}）` : item.what))
    .filter(text => text !== '')
  if (decisions.length > 0) lines.push(`[决策] ${decisions.join('；')}`)

  const lessons = []
  for (const error of fields.lessons.errors) {
    let segment = `${error.symptom}→${error.fix}`.replace(/^→|→$/g, '')
    if (error.cause !== '') segment += `（原因：${error.cause}）`
    if (segment !== '') lessons.push(segment)
  }
  lessons.push(...fields.lessons.patterns)
  if (lessons.length > 0) lines.push(`[经验] ${lessons.join('；')}`)

  const context = fields.context
  const env = []
  if (context.cwd !== '') env.push(`目录：${context.cwd}`)
  if (context.env.length > 0) env.push(`环境：${context.env.join('、')}`)
  if (context.commands.length > 0) env.push(`命令：${context.commands.join('、')}`)
  if (context.artifacts.length > 0) env.push(`引用：${context.artifacts.join('、')}`)
  if (context.constraints.length > 0) env.push(`约束：${context.constraints.join('、')}`)
  if (env.length > 0) lines.push(`[环境] ${env.join('；')}`)

  if (fields.user.length > 0) lines.push(`[用户] ${fields.user.join('、')}`)
  return lines
}
