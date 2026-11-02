/**
 * Web half of the memory-tree plugin: render the compaction marker as a memory card,
 * memory card instead of the backend's one-line row.
 *
 * This file is not a normal ES module. The client loader evaluates it in the
 * page and expects the `__ModuleLoader__.load({ id, factory })` envelope, where
 * the factory receives the app's own `require` (see
 * `@deepseek-ai/dsh-client-ui-brand-official/lib/client.js` for the same shape).
 * There is no build step: `react` is resolved from the app at runtime.
 *
 * The seat is `conversation.chat.node`, a keyed slot. Its contract says "Reusing
 * a key replaces that node renderer", so registering `compaction` replaces the
 * shipped `CompactionItem` row; a plugin that never loads simply leaves the
 * shipped row in place, which is the degradation we want.
 *
 * @module @xiaob/dsh-memory-tree/client
 */

window.__ModuleLoader__.load({
  id: '@xiaob/dsh-memory-tree',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const h = react.createElement

    /** Required service: the UI slot registry. */
    const inject = ['slots']

    /**
     * Build stamp, bumped on every behavioural change to this file.
     *
     * The host composes the client graph once at boot and then serves those
     * bytes immutably, so a stale page is indistinguishable from a broken one —
     * unless the build says which one it is. Keep this in the first console line.
     */
    const BUILD = '2026-11-02.8'

    // ── the checkpoint text → nodes ────────────────────────────────────────

    /** `[node0_001 · L0 · 第1-29条] [已压缩 · 不需要压缩]` */
    const HEAD = /^\[node(\d+)_(\d+) · L(\d+) · 第(\d+)-(\d+)条\]/
    /** `[记忆树] 共 5 个活跃节点，深度 L0，已折叠到第 150 条。…` */
    const DIGEST = /^\[记忆树\]/

    /**
     * Split the checkpoint body into the nodes it carries.
     *
     * The text is exactly what this plugin's summarizer returned to the backend,
     * so the shape is ours to rely on — but a checkpoint written by another
     * provider (or by an older build) will not match, and then this returns no
     * nodes and the card falls back to showing the raw text.
     * @param {string} text checkpoint summary.
     * @returns {{header: string, raw: string, nodes: object[]}} parsed card content.
     */
    function parseSummary(text) {
      const raw = String(text ?? '')
      // The backend joins the checkpoint's content blocks with an empty string,
      // so a digest written before block separators existed can read
      // `...节点。[node0_001 ...]`. Put every node header on its own line.
      const normalized = raw.replace(
        /(?<!\n)(?=\[node\d+_\d+ · L\d+ · 第\d+-\d+条\])/g,
        '\n',
      )
      const lines = normalized.split(/\r?\n/)
      let header = ''
      const nodes = []
      let current = null
      for (const line of lines) {
        const head = HEAD.exec(line)
        if (head !== null) {
          current = {
            id: `node${head[1]}_${head[2]}`,
            level: Number(head[3]),
            start: Number(head[4]),
            end: Number(head[5]),
            summary: '',
            time: '',
            body: [],
          }
          nodes.push(current)
          continue
        }
        if (current === null) {
          if (DIGEST.test(line)) header = line.replace(/^\[记忆树\]\s*/, '').trim()
          continue
        }
        if (line.startsWith('[摘要] ')) current.summary = line.slice(4).trim()
        else if (line.startsWith('[时间] ')) current.time = line.slice(4).trim()
        else if (line.trim() !== '' && !line.startsWith('[已压缩')) current.body.push(line)
      }
      return { header, raw: raw.trim(), nodes }
    }

    // ── B: fold the shadowed conversation into the card ────────────────────

    /** Rows this card hid, and the inline `display` each had before. */
    const folded = new Map()

    /**
     * The Chat row that owns this card.
     *
     * The slot renderer wraps a contribution in
     * `[data-slot="conversation.chat.node"]` (`display: contents`), so the card's
     * immediate parent is that wrapper — not the transcript row. Hiding the
     * wrapper's siblings would touch nothing. The row is the nearest ancestor
     * carrying `data-chat-node-key`.
     * @param {HTMLElement | null} self card root.
     * @returns {HTMLElement | null} owning row, or the immediate parent as a fallback.
     */
    function rowOf(self) {
      let element = self
      while (element !== null && element !== undefined) {
        if (typeof element.hasAttribute === 'function'
          && element.hasAttribute('data-chat-node-key')) return element
        element = element.parentElement
      }
      return self?.parentElement ?? null
    }

    /** Whether a transcript row contains a memory card. */
    function hasCard(row) {
      if (row === null || row === undefined) return false
      if (row.hasAttribute?.('data-memtree-card') === true) return true
      const found = row.querySelector?.('[data-memtree-card]')
      return found !== null && found !== undefined
    }

    /**
     * Hide or restore every transcript row above this card.
     *
     * DSH keeps the shadowed history in the transcript on purpose ("the marker
     * reports where the model stopped seeing that history, it does not replace
     * it"), and no supported seam can filter rows — so the fold is done on the
     * owning row's previous siblings, which is the one part of the transcript
     * this renderer can address. It deliberately walks past older memory cards:
     * two compactions are one evolving tree, so the latest card owns the fold
     * and the older card is hidden by the latest-only filter.
     *
     * Everything is guarded: an unexpected DOM (no row, a virtualized list that
     * recycles rows) leaves the transcript untouched rather than blanking it,
     * and unmount always restores.
     * The checkpoint is appended after the retained tail, so the rows closest
     * to the card are the newest context messages. `keep` leaves that many
     * previous rows visible and folds everything older; without it the card
     * would hide the very messages the retention setting kept.
     * @param {HTMLElement | null} self this card's root.
     * @param {boolean} hide whether to fold.
     * @param {number} [keep] previous rows to leave visible.
     * @returns {number} how many rows are folded.
     */
    function foldSiblings(self, hide, keep = 0) {
      const row = rowOf(self)
      const parent = row?.parentElement
      if (parent === null || parent === undefined) return 0
      let remaining = Math.max(0, Math.trunc(Number(keep) || 0))
      let count = 0
      let visited = 0
      let cursor = row.previousElementSibling
      while (cursor !== null && visited < 2000) {
        visited += 1
        try {
          if (hide) {
            if (remaining > 0) {
              remaining -= 1
              if (folded.has(cursor)) {
                cursor.style.display = folded.get(cursor) ?? ''
                folded.delete(cursor)
              }
            } else if (!folded.has(cursor)) {
              folded.set(cursor, cursor.style.display)
              cursor.style.display = 'none'
              count += 1
            }
          } else if (folded.has(cursor)) {
            cursor.style.display = folded.get(cursor) ?? ''
            folded.delete(cursor)
            count += 1
          }
        } catch {
          break
        }
        cursor = cursor.previousElementSibling
      }
      return count
    }

    // ── the card ───────────────────────────────────────────────────────────

    /**
     * Hide every transcript row before the oldest retained row.
     *
     * The Host records the Chat keys of the messages that survived the
     * replacement. Folding starts immediately before the oldest rendered one,
     * so the visible boundary is the configured retention boundary itself, not
     * a guessed row count, and no retained message is ever hidden.
     * @param {HTMLElement | null} self this card's root.
     * @param {readonly string[]} keys retained Chat row keys.
     * @returns {number} how many rows are folded.
     */
    function foldBeforeKeys(self, keys) {
      const wanted = new Set((Array.isArray(keys) ? keys : []).map(String))
      if (wanted.size === 0) return 0
      const row = rowOf(self)
      const parent = row?.parentElement
      if (parent === null || parent === undefined) return 0
      let rows
      try {
        rows = [...parent.querySelectorAll('[data-chat-node-key]')]
      } catch {
        return 0
      }
      const kept = rows.filter(element =>
        wanted.has(element.getAttribute('data-chat-node-key')))
      if (kept.length === 0) return 0
      const boundary = kept[0]
      const boundaryIndex = rows.indexOf(boundary)
      if (boundaryIndex <= 0) return 0
      // A grouping row before the boundary may contain a retained member;
      // hiding it would hide that member too. Build the protected ancestor set
      // once instead of asking every earlier row whether it contains a keeper.
      const protectedRows = new Set()
      for (const keptRow of kept) {
        for (let cursor = keptRow; cursor !== null && cursor !== parent;
          cursor = cursor.parentElement) {
          protectedRows.add(cursor)
        }
      }
      let count = 0
      for (let index = 0; index < boundaryIndex; index += 1) {
        const element = rows[index]
        // The checkpoint row (this card) sits immediately before the retained
        // tail in DOM order. It is the whole point of the fold, so never hide
        // the row that owns this card; CSS moves it to the top afterwards.
        if (element === row || element.contains?.(self) === true) continue
        if (protectedRows.has(element)) continue
        try {
          if (!folded.has(element)) {
            folded.set(element, element.style.display)
            element.style.display = 'none'
            count += 1
          }
        } catch {
          break
        }
      }
      return count
    }

    /** Restore every row this card hid, including rows nested in groups. */
    function restoreFolded() {
      for (const [element, display] of folded) {
        try {
          element.style.display = display
        } catch {
          // A recycled row no longer matters; the remaining entries still restore.
        }
      }
      folded.clear()
    }

    /** Rail marks hidden because their user prompt is outside the context. */
    const railHidden = new Map()

    /**
     * Hide turn-rail marks whose user message row is folded away.
     *
     * A mark has no message key, only the turn number in its accessible label.
     * Rows do carry `data-chat-turn`, so a turn stays navigable while any of its
     * user/steering rows remains visible; turns with rows but no visible user
     * row disappear from the rail. Turns that are merely not loaded keep their
     * marks, so paging still works.
     * @returns {void}
     */
    function filterTurnRail() {
      if (typeof document === 'undefined') return
      let rows
      try {
        rows = [...document.querySelectorAll('[data-chat-node-key]')]
      } catch {
        return
      }
      const visible = new Set()
      const foldedAway = new Set()
      for (const row of rows) {
        const key = String(row.getAttribute?.('data-chat-node-key') ?? '')
        if (!key.startsWith('13:input-message') && !key.startsWith('8:steering')) continue
        const turn = Number(row.getAttribute?.('data-chat-turn'))
        if (!Number.isSafeInteger(turn)) continue
        let shown = true
        try {
          // Read only the plugin's own inline fold state. getComputedStyle and
          // offsetParent force a layout for every row, which made a 6000-row
          // replacement commit spend seconds in this helper.
          for (let cursor = row; cursor !== null && cursor !== document.body;
            cursor = cursor.parentElement) {
            if (folded.has(cursor) || cursor.style?.display === 'none') {
              shown = false
              break
            }
          }
        } catch {
          shown = row.style?.display !== 'none'
        }
        if (shown) {
          visible.add(turn)
          foldedAway.delete(turn)
        } else if (!visible.has(turn)) {
          foldedAway.add(turn)
        }
      }
      let navs
      try {
        navs = [...document.querySelectorAll('nav')].filter(nav =>
          /turn|轮|回合/i.test(String(nav.getAttribute('aria-label') ?? '')))
      } catch {
        return
      }
      for (const nav of navs) {
        for (const button of nav.querySelectorAll('button[data-index]')) {
          const label = String(button.getAttribute('aria-label') ?? '')
          const number = label.match(/(\d+)(?!.*\d)/)
          if (number === null) continue
          const turn = Number(number[1])
          const hide = foldedAway.has(turn) && !visible.has(turn)
          if (hide) {
            if (!railHidden.has(button)) {
              railHidden.set(button, button.style.visibility)
              button.style.visibility = 'hidden'
            }
          } else if (railHidden.has(button)) {
            button.style.visibility = railHidden.get(button)
            railHidden.delete(button)
          }
        }
      }
    }

    /** Restore every rail mark this card hid. */
    function restoreTurnRail() {
      for (const [button, visibility] of railHidden) {
        try {
          button.style.visibility = visibility
        } catch {
          // A virtualized mark may already be gone.
        }
      }
      railHidden.clear()
    }

    const S = {
      card: {
        margin: '10px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontSize: '12.5px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-tertiary, #6b7280)',
      },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 2px 0' },
      label: {
        flex: 'none',
        fontSize: '10px',
        letterSpacing: '0.4px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-tertiary, #6b7280)',
      },
      meta: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tool: {
        flex: 'none',
        cursor: 'pointer',
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
        background: 'none',
        border: 'none',
        padding: '2px 4px',
        borderRadius: '6px',
      },
      nodeCard: {
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        padding: '10px 12px',
      },
      nodeHead: {
        display: 'flex',
        gap: '8px',
        alignItems: 'baseline',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
      },
      nodeId: {
        fontFamily: 'var(--dsw-font-markdown-code-block-small-font-family, ui-monospace)',
        fontSize: '12px',
        fontWeight: 700,
        color: 'var(--dsw-alias-label-primary, #111827)',
      },
      nodeRange: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
      },
      nodeTime: { flex: 'none', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      nodeSummary: {
        marginTop: '3px',
        color: 'var(--dsw-alias-label-tertiary, #6b7280)',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      nodeSummaryOpen: { marginTop: '3px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      nodeBody: {
        marginTop: '7px',
        paddingTop: '7px',
        borderTop: '1px dashed var(--dsw-alias-border-l2, #e5e7eb)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
      },
      fieldRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '7px',
        padding: '3px 0 3px 7px',
        borderLeft: '3px solid var(--dsw-alias-border-l2, #e5e7eb)',
        lineHeight: 1.65,
      },
      fieldLabel: {
        flex: 'none',
        minWidth: '34px',
        fontSize: '10.5px',
        fontWeight: 700,
        letterSpacing: '0.2px',
      },
      fieldText: {
        flex: '1 1 auto',
        minWidth: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
      },
      plainLine: {
        padding: '2px 0 2px 7px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
      },
      children: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        marginTop: '7px',
      },
      childCard: {
        borderLeft: '2px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base, #fff)',
        padding: '7px 9px',
      },
      detail: {
        marginTop: '6px',
        paddingTop: '5px',
        borderTop: '1px dotted var(--dsw-alias-border-l2, #e5e7eb)',
      },
      detailRole: {
        display: 'block',
        fontSize: '10.5px',
        color: 'var(--dsw-alias-label-tertiary, #6b7280)',
        marginBottom: '2px',
      },
      detailText: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
        fontSize: '12px',
      },
      note: { marginTop: '5px', fontSize: '11px', opacity: 0.8 },
      delta: {
        margin: '0 2px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary, #6b7280)',
      },
    }

    /** Field colors keep the six structured groups distinguishable at a glance. */
    const FIELD_COLORS = {
      概述: '#2563eb',
      任务: '#059669',
      决策: '#b45309',
      经验: '#7c3aed',
      环境: '#475569',
      用户: '#be185d',
      时间: '#64748b',
    }

    /**
     * Render one node body. Structured lines use a colored left rule and label;
     * unknown text still gets readable spacing instead of a wall of gray text.
     * @param {string} body field lines or raw body text.
     * @returns {object[]} rows.
     */
    function renderFieldRows(body) {
      const lines = String(body ?? '').split(/\r?\n/).filter(line => line.trim() !== '')
      return lines.map((line, index) => {
        const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line)
        if (match === null) {
          return h('div', { key: `line-${index}`, style: S.plainLine }, line)
        }
        const color = FIELD_COLORS[match[1]] ?? 'var(--dsw-alias-border-l2, #e5e7eb)'
        return h('div', {
          key: `field-${index}`,
          style: { ...S.fieldRow, borderLeftColor: color },
        }, [
          h('span', { key: 'label', style: { ...S.fieldLabel, color } }, match[1]),
          h('span', { key: 'text', style: S.fieldText }, match[2]),
        ])
      })
    }

    /**
     * All loaded descendants of one node, so collapsing a branch also clears
     * the open state of its children.
     * @param {Record<string, {children?: object[]}>} cache loaded node data.
     * @param {string} id root node id.
     * @returns {Set<string>} descendant ids.
     */
    function collectDescendants(cache, id) {
      const found = new Set()
      const queue = [String(id)]
      while (queue.length > 0) {
        const current = queue.shift()
        const children = cache[current]?.children
        if (!Array.isArray(children)) continue
        for (const child of children) {
          const childId = String(child.id)
          if (found.has(childId)) continue
          found.add(childId)
          queue.push(childId)
        }
      }
      return found
    }

    /** Compact token count for the card's release line. */
    function shortTokens(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return '0'
      if (number >= 1_000_000) return `${Math.round(number / 100_000) / 10}M`
      if (number >= 1_000) return `${Math.round(number / 100) / 10}K`
      return String(Math.round(number))
    }

    /**
     * Latest-only registry for compaction cards.
     *
     * The transcript keeps older compaction markers in its history; the tree
     * is one evolving structure, so only the card with the largest shadowed
     * end renders. The newest card owns the fold and hides every older row,
     * including older cards.
     */
    const cardEnds = new Map()
    const cardListeners = new Set()

    function latestCardEnd() {
      let latest = 0
      for (const value of cardEnds.values()) latest = Math.max(latest, value)
      return latest
    }

    function useLatestCard(id, end) {
      const [latest, setLatest] = react.useState(0)
      react.useEffect(() => {
        if (id === '' || end <= 0) return undefined
        cardEnds.set(id, end)
        const update = () => setLatest(latestCardEnd())
        cardListeners.add(update)
        update()
        return () => {
          cardEnds.delete(id)
          cardListeners.delete(update)
          update()
        }
      }, [id, end])
      if (latest === 0 || end <= 0) return true
      return end >= latest
    }

    /**
     * Memory card, filled with the tree this plugin wrote.
     * @param {{node?: {data?: object, summary?: string}, data?: object}} props Chat node props.
     * @returns {object} the card element.
     */
    function MemoryTreeCard({ node, sessionId }) {
      // The seat hands over the Chat node, whose payload sits on `.data`; tolerate
      // the payload itself so a shape change degrades to a plain card instead of
      // an empty one.
      const data = (node?.data ?? node ?? {})
      const cardId = String(data.compactionId ?? '')
      // `CompactionSummaryNode` exposes the summary event's seq; the range
      // fields belong to the summary payload and are not part of the node.
      const cardEnd = Number(data.summaryEventSeq)
        || Number(data.shadowedRange?.end)
        || Number(Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.at(-1) : 0)
        || 0
      const isLatest = useLatestCard(cardId, cardEnd)
      const parsed = react.useMemo(() => {
        try {
          return parseSummary(data.summary)
        } catch {
          return { header: '', raw: String(data.summary ?? ''), nodes: [] }
        }
      }, [data.summary])
      const [expanded, setExpanded] = react.useState(() => new Set())
      const [nodeCache, setNodeCache] = react.useState({})
      const loading = react.useRef(new Set())
      const [keepKeys, setKeepKeys] = react.useState(null)
      const [keepRevision, setKeepRevision] = react.useState(0)
      const root = react.useRef(null)

      // The card node carries the checkpoint seq but not the retained rows.
      // Read the Host's keep set so the fold boundary is the actual retention
      // boundary rather than a fixed number of DOM rows.
      react.useEffect(() => {
        if (!isLatest) return undefined
        const checkpoint = Number(data.seq)
        if (!Number.isSafeInteger(checkpoint) || checkpoint <= 0) return undefined
        let alive = true
        const query = new URLSearchParams({ compaction: String(checkpoint) })
        if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
          query.set('session', String(sessionId))
        }
        const token = new URLSearchParams(location.search).get('token')
        if (token !== null && token !== '') query.set('token', token)
        void fetch(`/memory-tree/api/status?${query.toString()}`, { cache: 'no-store' })
          .then(response => response.ok ? response.json() : null)
          .then(body => {
            if (!alive) return
            if (body?.enabled === false) {
              setKeepKeys(null)
              return
            }
            setKeepKeys(Array.isArray(body?.keep) ? body.keep.map(String) : null)
          })
          .catch(() => {
            // No keep set means no DOM fold; showing compressed history is
            // safer than hiding retained messages.
            if (alive) setKeepKeys(null)
          })
        return () => { alive = false }
      }, [isLatest, data.seq, sessionId, keepRevision])

      react.useEffect(() => {
        if (!isLatest) return undefined
        const onSessionSwitch = (event) => {
          const detail = event?.detail
          if (String(detail?.sessionId ?? '') !== String(sessionId ?? '')) return
          if (detail.enabled === false) {
            setKeepKeys(null)
          } else {
            // Re-read the persisted boundary when the session is switched back
            // on; a stale page does not need a reload to restore the card.
            setKeepRevision(value => value + 1)
          }
        }
        window.addEventListener('memtree-session-changed', onSessionSwitch)
        return () => window.removeEventListener('memtree-session-changed', onSessionSwitch)
      }, [isLatest, sessionId])

      // Folding lives in an effect because it touches siblings React does not
      // own. Re-running on every child mutation keeps it correct when the
      // transcript appends a turn while the card stays mounted. The fold is
      // permanent: the card is the start of the visible conversation, and there
      // is no "expand original" affordance.
      react.useEffect(() => {
        if (!isLatest || !Array.isArray(keepKeys)) return undefined
        const self = root.current
        if (self === null) return undefined
        console.info(`[memtree] card rendered (${parsed.nodes.length} node(s))`,
          { nodeKeys: Object.keys(node ?? {}), dataKeys: Object.keys(data ?? {}) })
        try {
          const row = rowOf(self)
          const parent = row?.parentElement
          if (row === null || row === undefined || parent === null || parent === undefined) {
            return undefined
          }
          const originalNext = row.nextSibling
          const originalOrder = row.style.order ?? ''
          row.style.order = ''
          // The checkpoint anchor is newer than the retained messages, so DOM
          // order puts the card after them. `order: -1` depends on the transcript
          // being a flex/grid container and did not move it in practice; move the
          // row itself and let the observer restore that after every re-render.
          let scheduled = 0
          let railScheduled = 0
          let disposed = false
          const scheduleRail = () => {
            if (disposed || railScheduled !== 0) return
            railScheduled = setTimeout(() => {
              railScheduled = 0
              if (!disposed) filterTurnRail()
            }, 80)
          }
          const apply = () => {
            if (disposed) return
            if (keepKeys.length === 0) foldSiblings(self, true)
            else foldBeforeKeys(self, keepKeys)
            if (parent.firstElementChild !== row) {
              parent.insertBefore(row, parent.firstElementChild)
            }
            scheduleRail()
          }
          const schedule = () => {
            if (disposed || scheduled !== 0) return
            // A replacement commit can produce hundreds of child-list
            // notifications. Coalesce them; one scan after the commit is enough.
            scheduled = setTimeout(() => {
              scheduled = 0
              apply()
            }, 40)
          }
          // Let the replacement paint once before manipulating thousands of
          // sibling rows; the fold is visual and a short delay is invisible.
          schedule()
          const observer = new MutationObserver(schedule)
          // Only direct row inserts/removals matter; observing the whole subtree
          // made every streaming token re-scan the transcript.
          observer.observe(parent, { childList: true })
          return () => {
            disposed = true
            observer.disconnect()
            if (scheduled !== 0) clearTimeout(scheduled)
            if (railScheduled !== 0) clearTimeout(railScheduled)
            restoreFolded()
            restoreTurnRail()
            if (originalNext !== null && originalNext.parentElement === parent) {
              parent.insertBefore(row, originalNext)
            } else if (originalNext === null || row.parentElement !== parent) {
              parent.appendChild(row)
            }
            row.style.order = originalOrder
          }
        } catch (error) {
          // Hiding rows is a bonus: if the DOM is not what this expects, the card
          // stays and nothing above it is touched.
          console.warn('[memtree] could not fold the shadowed transcript:', error)
          return undefined
        }
      }, [isLatest, keepKeys])

      if (!isLatest) return null

      const loadNode = (id) => {
        if (nodeCache[id] !== undefined || loading.current.has(id)) return
        if (sessionId === undefined || sessionId === null || sessionId === '') return
        loading.current.add(id)
        setNodeCache(cache => ({ ...cache, [id]: { loading: true } }))
        const query = new URLSearchParams({ session: String(sessionId), id: String(id) })
        const token = new URLSearchParams(location.search).get('token')
        if (token !== null && token !== '') query.set('token', token)
        void fetch(`/memory-tree/api/node?${query.toString()}`, { cache: 'no-store' })
          .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then(body => {
            setNodeCache(cache => ({ ...cache, [id]: { ...body, loading: false } }))
          })
          .catch(error => {
            setNodeCache(cache => ({
              ...cache,
              [id]: { loading: false, error: error instanceof Error ? error.message : String(error) },
            }))
          })
          .finally(() => {
            loading.current.delete(id)
          })
      }

      const descendantIds = id => collectDescendants(nodeCache, id)

      const forgetCached = (ids) => {
        setNodeCache(cache => {
          const next = { ...cache }
          let changed = false
          for (const id of ids) {
            if (next[id] === undefined) continue
            delete next[id]
            changed = true
          }
          return changed ? next : cache
        })
      }

      const toggleNode = (id) => {
        if (expanded.has(id)) {
          // Collapsing a branch also clears everything loaded beneath it, so
          // reopening starts closed and the client does not retain old bodies.
          const descendants = descendantIds(id)
          setExpanded(previous => {
            const next = new Set(previous)
            for (const descendant of descendants) next.delete(descendant)
            next.delete(id)
            return next
          })
          forgetCached([id, ...descendants])
          return
        }
        setExpanded(previous => {
          const next = new Set(previous)
          next.add(id)
          return next
        })
        loadNode(id)
      }

      const collapseAll = () => {
        setExpanded(new Set())
        setNodeCache({})
      }

      const shadowedCount = Number(data.shadowedItemCount) || 0
      const shadowedTokens = Number(data.shadowedTokenCount) || 0
      // The checkpoint's own token count is enough here; the composer owns the
      // context percentage.
      const summaryTokens = Number(data.checkpointTokens) > 0
        ? Number(data.checkpointTokens)
        : Math.ceil(String(data.summary ?? '').length / 4) + 8
      const summaryShare = `摘要节点 ~${shortTokens(summaryTokens)} token`

      const children = [
        h('div', { key: 'bar', style: S.bar }, [
          h('div', { key: 'label', style: S.label },
            parsed.nodes.length === 0 ? '记忆摘要' : `记忆摘要 · ${parsed.nodes.length} 个节点`),
          h('div', { key: 'meta', style: S.meta },
            parsed.header === ''
              ? (data.shadowedItemCount ? `已压缩 ${data.shadowedItemCount} 条上下文` : '早期对话已压缩')
              : parsed.header),
          expanded.size > 0
            ? h('button', {
              key: 'collapse',
              type: 'button',
              style: S.tool,
              onClick: collapseAll,
              title: '收起所有已展开的节点',
            }, '全部收起')
            : null,
        ]),
        shadowedCount > 0
          ? h('div', { key: 'delta', style: S.delta },
            `本次压缩 ${shadowedCount} 条 · 释放约 ${shortTokens(shadowedTokens)} token`)
          : null,
        h('div', { key: 'share', style: S.delta }, summaryShare),
      ]

      const renderNode = (item, depth = 0) => {
        const id = String(item.id)
        const open = expanded.has(id)
        const cached = nodeCache[id]
        const body = cached?.body !== undefined && cached.body !== ''
          ? cached.body
          : (Array.isArray(item.body) ? item.body.join('\n') : '')
        const level = cached?.level ?? item.level
        const start = cached?.start ?? item.start
        const end = cached?.end ?? item.end
        const time = cached?.time ?? item.time
        const summary = cached?.summary ?? item.summary
        const childNodes = Array.isArray(cached?.children) ? cached.children : []
        const details = Array.isArray(cached?.details) ? cached.details : []
        const containerStyle = depth > 0
          ? { ...S.nodeCard, ...S.childCard, marginLeft: '10px' }
          : S.nodeCard
        const openParts = []
        if (cached?.loading === true) {
          openParts.push(h('div', { key: 'loading', style: S.note }, '正在读取子节点…'))
        }
        if (cached?.error !== undefined) {
          openParts.push(h('div', { key: 'error', style: S.note }, `读取失败：${cached.error}`))
        }
        if (body !== '') {
          openParts.push(h('div', { key: 'fields' }, renderFieldRows(body)))
        }
        if (childNodes.length > 0) {
          openParts.push(h('div', { key: 'children', style: S.children },
            childNodes.map(child => renderNode(child, depth + 1))))
        }
        if (details.length > 0) {
          openParts.push(h('div', { key: 'details' }, [
            h('div', { key: 'label', style: S.note }, '原始消息'),
            ...details.map((detail, index) => h('div', {
              key: `detail-${index}`,
              style: S.detail,
            }, [
              h('span', { key: 'role', style: S.detailRole },
                `${detail.role === 'assistant' ? '助手' : detail.role === 'user' ? '用户' : detail.role}${detail.time ? ` · ${detail.time}` : ''}`),
              h('div', { key: 'text', style: S.detailText }, detail.text),
            ])),
          ]))
        }
        if (cached !== undefined && cached.loading !== true && cached.error === undefined
          && body === '' && childNodes.length === 0 && details.length === 0) {
          openParts.push(h('div', { key: 'empty', style: S.note }, '这个节点没有留下更多原文。'))
        }
        return h('div', {
          key: id,
          style: containerStyle,
          'data-memtree-node': id,
        }, [
          h('div', {
            key: 'head',
            style: S.nodeHead,
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            onClick: () => toggleNode(id),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggleNode(id)
              }
            },
          }, [
            h('span', { key: 'id', style: S.nodeId }, id),
            h('span', { key: 'range', style: S.nodeRange },
              `${level !== undefined ? `L${level} · ` : ''}第${start}-${end}条`),
            h('span', { key: 'time', style: S.nodeTime }, time),
          ]),
          h('div', { key: 'summary', style: open ? S.nodeSummaryOpen : S.nodeSummary }, summary),
          open ? h('div', { key: 'body', style: S.nodeBody }, openParts) : null,
        ])
      }

      if (parsed.nodes.length === 0) {
        // Not our checkpoint (another provider, or a checkpoint older than the
        // tree): show the text rather than an empty card.
        children.push(h('div', { key: 'raw', style: S.nodeCard }, [
          h('div', { key: 'rawText', style: S.nodeBody }, parsed.raw),
        ]))
        return h('div', { ref: root, 'data-memtree-card': '', style: S.card }, children)
      }

      for (const item of parsed.nodes) children.push(renderNode(item))

      return h('div', { ref: root, 'data-memtree-card': '', style: S.card }, children)
    }

    // ── settings page ─────────────────────────────────────────────────────

    /** Host settings namespace owned by the plugin entry. */
    const SETTINGS_NS = 'memory-tree'

    /** Numeric settings, with their label, hint, and lower bound. */
    const SETTINGS_NUMBERS = [
      ['chunkTokens', '每片 token 上限', '一次压缩请求的分片上限，默认 30000。', 1],
      ['maxChunks', '每轮最多分片', '一次压缩最多切几片，默认 12。', 1],
      ['triggerTokens', '触发阈值（token）', '0 = 按模型窗口比例；正数时达到这个预算才触发压缩。', 0],
      ['retainMessages', '保留最近消息条数', '只按消息条数保留；最近 N 条整消息原样留在上下文里。', 1],
      ['nodeBudget', '节点字数预算', '整节点目标字数，默认 1000，summary 约占 40%。', 200],
      ['mergeThreshold', '合并阈值', '某层活跃节点达到这个数才合并，默认 8。', 2],
      ['branch', '每次合并节点数', '每次取最早几个节点合并，默认 4。', 2],
      ['maxMerges', '每轮最多合并批数', '一次压缩最多向上合并几批，默认 8。', 1],
    ]

    /** Prompt templates, grouped by language and kind. */
    const PROMPT_KINDS = [
      ['leaf', '叶子压缩'],
      ['leafScope', '单分片范围'],
      ['leafScopeChunk', '多分片范围'],
      ['budget', '长度预算'],
      ['skeleton', 'JSON 形状'],
      ['parent', '父节点合并'],
      ['retry', '截断重试'],
    ]

    const PROMPT_FIELD = {
      leaf: 'promptLeaf',
      leafScope: 'promptLeafScope',
      leafScopeChunk: 'promptLeafScopeChunk',
      budget: 'promptBudget',
      skeleton: 'promptSkeleton',
      parent: 'promptParent',
      retry: 'promptRetry',
    }

    const PROMPT_PLACEHOLDERS = {
      leaf: '{scope} {cwd_line} {budget_line}',
      leafScope: '{marker} {start} {end}',
      leafScopeChunk: '{marker} {start} {end} {anchor} {anchor_end}',
      budget: '{chars} {summary} {rest}',
      skeleton: '（无占位符）',
      parent: '{n} {ids} {marker} {budget_line}',
      retry: '{chars} {summary}',
    }

    const ALL_SETTINGS_FIELDS = [
      ...SETTINGS_NUMBERS.map(([field]) => field),
      'language',
      'async',
      ...PROMPT_KINDS.flatMap(([kind]) => [`${PROMPT_FIELD[kind]}Zh`, `${PROMPT_FIELD[kind]}En`]),
    ]

    const SS = {
      section: { maxWidth: '780px', padding: '2px 2px 24px', color: 'var(--dsw-alias-label-primary, #111827)' },
      title: { margin: '0 0 6px', fontSize: '16px', fontWeight: 600 },
      intro: { margin: '0 0 14px', color: 'var(--dsw-alias-label-tertiary, #6b7280)', fontSize: '12.5px', lineHeight: 1.7 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '10px',
        padding: '12px 14px',
        marginBottom: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      cardTitle: { margin: '0 0 10px', fontSize: '13px', fontWeight: 600 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px 14px' },
      field: { display: 'flex', flexDirection: 'column', gap: '3px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #4b5563)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '5px 8px',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
        font: 'inherit',
        fontSize: '12.5px',
      },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #6b7280)', lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      button: {
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
        padding: '4px 9px',
        fontSize: '12px',
      },
      primary: {
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-business-primary, #2563eb)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-state-business-primary, #2563eb)',
        color: '#fff',
        padding: '5px 12px',
        fontSize: '12px',
      },
      active: {
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-business-primary, #2563eb)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-state-business-primary-alpha, #eff6ff)',
        color: 'var(--dsw-alias-state-business-primary, #2563eb)',
        padding: '4px 9px',
        fontSize: '12px',
      },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '340px',
        resize: 'vertical',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
        fontFamily: 'var(--dsw-font-markdown-code-block-small-font-family, ui-monospace, Consolas, monospace)',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      },
      note: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      error: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #b91c1c)' },
      status: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        margin: '4px 0',
        padding: '2px 8px',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-tertiary, #6b7280)',
        fontSize: '11px',
        lineHeight: 1.5,
      },
    }

    /** Tiny observable store used as the slot's hooks compartment. */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          snapshot = next
          for (const listener of listeners) listener()
        },
      }
    }

    /** Bridge one ConfigForm scope into a store plus save/reset callbacks. */
    function createSettingsController(scope) {
      const store = createStore(scope.getSnapshot())
      const off = scope.subscribe(() => store.set(scope.getSnapshot()))
      return {
        store,
        save: (ops, revision) => scope.mutate(ops, revision),
        reset: (field) => scope.unset(field),
        dispose: off,
      }
    }

    /** Seed editable text from one resolved section. */
    function seedDrafts(value) {
      const drafts = {}
      for (const field of ALL_SETTINGS_FIELDS) {
        const raw = value?.[field]
        drafts[field] = raw === undefined || raw === null ? '' : String(raw)
      }
      return drafts
    }

    /** One numeric settings control. */
    function NumberSetting({ field, label, hint, text, overridden, disabled, onEdit, onReset }) {
      return h('label', { style: SS.field }, [
        h('span', { key: 'label', style: SS.label }, [
          label,
          overridden
            ? h('button', {
              key: 'reset',
              type: 'button',
              style: { ...SS.button, marginLeft: '8px', padding: '1px 6px', fontSize: '10px' },
              disabled,
              onClick: (event) => { event.preventDefault(); onReset(field) },
            }, '默认')
            : null,
        ]),
        h('input', {
          key: 'input',
          type: 'text',
          inputMode: 'numeric',
          style: SS.input,
          value: text,
          disabled,
          onChange: (event) => onEdit(field, event.target.value),
        }),
        h('span', { key: 'hint', style: SS.hint }, hint),
      ])
    }

    /**
     * The Memory Tree settings section: compression budgets, trigger policy,
     * and the editable prompt templates.
     */
    function MemoryTreeSettings({ useMemoryTreeSettings, save, resetField }) {
      const snapshot = useMemoryTreeSettings(value => value)
      const [drafts, setDrafts] = react.useState(null)
      const [language, setLanguage] = react.useState('zh')
      const [kind, setKind] = react.useState('leaf')
      const [notice, setNotice] = react.useState('')
      const [saving, setSaving] = react.useState(false)
      const dirty = react.useRef(false)

      react.useEffect(() => {
        if (snapshot.status !== 'ready' || snapshot.value === undefined || dirty.current) return
        setDrafts(seedDrafts(snapshot.value))
      }, [snapshot.status, snapshot.value, snapshot.revision])

      const edit = (field, text) => {
        dirty.current = true
        setDrafts(previous => ({ ...(previous ?? {}), [field]: text }))
        setNotice('')
      }

      const reset = async (field) => {
        try {
          const ok = await resetField(field)
          dirty.current = false
          setNotice(ok ? '已恢复默认' : '恢复默认被 Host 拒绝')
        } catch (error) {
          setNotice(`恢复失败：${String(error?.message ?? error)}`)
        }
      }

      const discard = () => {
        dirty.current = false
        setDrafts(seedDrafts(snapshot.value))
        setNotice('已放弃未保存的修改')
      }

      const persist = async () => {
        if (drafts === null || snapshot.value === undefined) return
        const ops = []
        let problem = ''
        for (const [field, label, , min] of SETTINGS_NUMBERS) {
          const raw = String(drafts[field] ?? '').trim()
          if (raw === '') {
            ops.push({ op: 'unset', path: [field] })
            continue
          }
          const number = Number(raw)
          if (!Number.isInteger(number) || number < min) {
            problem = `${label} 必须是 ≥ ${min} 的整数`
            break
          }
          if (number !== snapshot.value[field]) {
            ops.push({ op: 'set', path: [field], value: number })
          }
        }
        if (problem === '') {
          if (drafts.language !== snapshot.value.language) {
            ops.push({ op: 'set', path: ['language'], value: drafts.language })
          }
          const asyncValue = drafts.async === 'true'
          if (asyncValue !== snapshot.value.async) {
            ops.push({ op: 'set', path: ['async'], value: asyncValue })
          }
          for (const [kindName, field] of Object.entries(PROMPT_FIELD)) {
            for (const suffix of ['Zh', 'En']) {
              const key = `${field}${suffix}`
              const text = String(drafts[key] ?? '')
              if (text.trim() === '') {
                ops.push({ op: 'unset', path: [key] })
              } else if (text !== snapshot.value[key]) {
                ops.push({ op: 'set', path: [key], value: text })
              }
            }
          }
        }
        if (problem !== '') {
          setNotice(problem)
          return
        }
        if (ops.length === 0) {
          setNotice('没有需要保存的修改')
          return
        }
        setSaving(true)
        try {
          const ok = await save(ops, snapshot.revision)
          if (ok) {
            dirty.current = false
            setNotice('已保存，下一轮压缩生效')
          } else {
            setNotice('Host 拒绝了这次修改；设置已重新读取')
          }
        } catch (error) {
          setNotice(`保存失败：${String(error?.message ?? error)}`)
        } finally {
          setSaving(false)
        }
      }

      if (snapshot.status !== 'ready' || snapshot.value === undefined) {
        return h('section', { style: SS.section }, [
          h('h2', { key: 'title', style: SS.title }, '记忆树压缩'),
          h('p', { key: 'status', style: SS.intro },
            snapshot.status === 'unavailable' ? '设置服务未启用，无法编辑。' : '正在读取设置…'),
        ])
      }

      const promptField = `${PROMPT_FIELD[kind]}${language === 'en' ? 'En' : 'Zh'}`
      const promptValue = drafts?.[promptField] ?? ''
      const overridden = (field) => Object.prototype.hasOwnProperty.call(snapshot.user ?? {}, field)

      return h('section', { style: SS.section }, [
        h('h2', { key: 'title', style: SS.title }, '记忆树压缩'),
        h('p', { key: 'intro', style: SS.intro },
          '这里编辑的是下一次压缩会用的参数和提示词。数值留空会回到默认值；提示词留空会恢复内置模板。'),
        h('div', { key: 'budget', style: SS.card }, [
          h('h3', { key: 'head', style: SS.cardTitle }, '压缩预算'),
          h('div', { key: 'grid', style: SS.grid },
            SETTINGS_NUMBERS.map(([field, label, hint, min]) => h(NumberSetting, {
              key: field,
              field,
              label,
              hint,
              text: drafts?.[field] ?? '',
              overridden: overridden(field),
              disabled: !snapshot.writable || saving,
              onEdit: edit,
              onReset: reset,
            }))),
          h('div', { key: 'row', style: { ...SS.row, marginTop: '10px' } }, [
            h('label', { key: 'lang', style: SS.field }, [
              h('span', { key: 'label', style: SS.label }, '压缩语言'),
              h('select', {
                key: 'select',
                style: SS.input,
                value: drafts?.language ?? 'zh',
                disabled: !snapshot.writable || saving,
                onChange: (event) => edit('language', event.target.value),
              }, [
                h('option', { key: 'zh', value: 'zh' }, '中文（zh）'),
                h('option', { key: 'en', value: 'en' }, 'English（en）'),
              ]),
            ]),
            h('label', { key: 'async', style: { ...SS.row, marginTop: '16px' } }, [
              h('input', {
                key: 'check',
                type: 'checkbox',
                checked: drafts?.async !== 'false',
                disabled: !snapshot.writable || saving,
                onChange: (event) => edit('async', event.target.checked ? 'true' : 'false'),
              }),
              h('span', { key: 'text', style: SS.label }, '后台异步压缩（不阻塞当前回合）'),
            ]),
          ]),
        ]),
        h('div', { key: 'prompt', style: SS.card }, [
          h('h3', { key: 'head', style: SS.cardTitle }, '压缩提示词模板'),
          h('div', { key: 'langRow', style: SS.row }, [
            h('span', { key: 'label', style: SS.label }, '语言'),
            ...['zh', 'en'].map(code => h('button', {
              key: code,
              type: 'button',
              style: language === code ? SS.active : SS.button,
              onClick: () => setLanguage(code),
            }, code === 'zh' ? '中文' : 'English')),
          ]),
          h('div', { key: 'kindRow', style: { ...SS.row, marginTop: '8px' } },
            PROMPT_KINDS.map(([name, label]) => h('button', {
              key: name,
              type: 'button',
              style: kind === name ? SS.active : SS.button,
              onClick: () => setKind(name),
            }, label))),
          h('div', { key: 'meta', style: { ...SS.row, marginTop: '10px' } }, [
            h('span', { key: 'file', style: SS.hint },
              `${PROMPT_FIELD[kind]}${language === 'en' ? 'En' : 'Zh'} · 占位符：${PROMPT_PLACEHOLDERS[kind]}`),
            overridden(promptField)
              ? h('button', {
                key: 'resetPrompt',
                type: 'button',
                style: SS.button,
                disabled: !snapshot.writable || saving,
                onClick: () => reset(promptField),
              }, '恢复默认模板')
              : null,
          ]),
          h('textarea', {
            key: 'textarea',
            style: { ...SS.textarea, marginTop: '6px' },
            value: promptValue,
            disabled: !snapshot.writable || saving,
            spellCheck: false,
            onChange: (event) => edit(promptField, event.target.value),
          }),
          h('p', { key: 'hint', style: SS.hint },
            '占位符必须保留；Host 会按当前参数渲染。模板里没有的字段可以不写，但 JSON 形状模板不建议删键。'),
        ]),
        h('div', { key: 'actions', style: { ...SS.row, marginTop: '12px' } }, [
          h('button', { key: 'save', type: 'button', style: SS.primary, disabled: !snapshot.writable || saving, onClick: () => { void persist() } },
            saving ? '保存中…' : '保存'),
          h('button', { key: 'discard', type: 'button', style: SS.button, disabled: saving, onClick: discard }, '放弃修改'),
          notice === ''
            ? null
            : h('span', { key: 'notice', style: SS.note }, notice),
        ]),
      ])
    }

    /**
     * The shipped transcript's "load earlier" button. It has no data attribute,
     * so identify it by its label and its `_older` row class.
     */
    function isLoadEarlierButton(button) {
      const text = String(button?.textContent ?? '').trim()
      if (text === '') return false
      const parentClass = String(button.parentElement?.className ?? '')
      if (/加载更早/.test(text) || /^load earlier/i.test(text)) return true
      return /older/i.test(parentClass) && /加载中|loading/i.test(text)
    }

    /**
     * Ambient status pill below the composer: polls the Host's in-memory job
     * snapshot so a background compaction is visible while it runs. It also
     * reveals the oldest memory card on session open: the transcript starts on
     * the newest page, so the card can sit behind "load earlier". The button is
     * hidden immediately and clicked programmatically until the card is in the
     * DOM; there is no user-visible pager.
     */
    function MemoryTreeStatus({ sessionId }) {
      const [job, setJob] = react.useState(null)
      const [last, setLast] = react.useState(null)
      const [live, setLive] = react.useState(null)
      const [enabled, setEnabled] = react.useState(false)
      const [busy, setBusy] = react.useState(false)

      react.useEffect(() => {
        if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
        let alive = true
        let clicks = 0
        let revealed = false
        let scheduled = 0
        let scrolling = 0
        let observer
        let timer
        const hidden = new Map()
        const hide = (button) => {
          const box = button.parentElement
          if (box === null || box === undefined) return
          if (!hidden.has(box)) hidden.set(box, box.style.display)
          box.style.display = 'none'
        }
        const stopWatching = () => {
          if (observer !== undefined) {
            observer.disconnect()
            observer = undefined
          }
          if (timer !== undefined) {
            clearInterval(timer)
            timer = undefined
          }
          if (scheduled !== 0) {
            clearTimeout(scheduled)
            scheduled = 0
          }
        }
        const tick = () => {
          if (!alive || revealed) return
          const pager = [...document.querySelectorAll('button')].filter(isLoadEarlierButton)
          for (const button of pager) hide(button)
          const card = document.querySelector('[data-memtree-card]')
          if (card !== null) {
            revealed = true
            // The card is the target; stop observing the whole document, which
            // otherwise re-scans every button on every streamed token.
            stopWatching()
            scrolling = setTimeout(() => {
              if (alive) card.scrollIntoView({ block: 'start' })
            }, 80)
            return
          }
          if (clicks >= 40) {
            stopWatching()
            return
          }
          const button = pager.find(candidate => candidate.disabled !== true)
          if (button === undefined) return
          clicks += 1
          button.click()
        }
        const schedule = () => {
          if (!alive || revealed || scheduled !== 0) return
          scheduled = setTimeout(() => {
            scheduled = 0
            tick()
          }, 120)
        }
        tick()
        if (!revealed) {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
          timer = setInterval(schedule, 1000)
        }
        return () => {
          alive = false
          stopWatching()
          if (scrolling !== 0) clearTimeout(scrolling)
          for (const [box, display] of hidden) box.style.display = display
        }
      }, [sessionId])

      react.useEffect(() => {
        if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
        let alive = true
        const tick = async () => {
          try {
            const query = new URLSearchParams({ session: String(sessionId) })
            const token = new URLSearchParams(location.search).get('token')
            if (token !== null && token !== '') query.set('token', token)
            const response = await fetch(`/memory-tree/api/status?${query.toString()}`, { cache: 'no-store' })
            if (!response.ok) return
            const data = await response.json()
            if (alive) {
              setJob(Array.isArray(data?.jobs) ? data.jobs[0] ?? null : null)
              setLast(data?.last ?? null)
              setLive(data?.live ?? null)
              setEnabled(data?.enabled !== false)
            }
          } catch {
            // The badge is a convenience; a route miss must stay silent.
          }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, 1000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      const toggle = async (event) => {
        const next = event.target.checked === true
        setEnabled(next)
        setBusy(true)
        try {
          const query = new URLSearchParams({ session: String(sessionId) })
          const token = new URLSearchParams(location.search).get('token')
          if (token !== null && token !== '') query.set('token', token)
          const response = await fetch(`/memory-tree/api/session?${query.toString()}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          })
          if (!response.ok) throw new Error(String(response.status))
          window.dispatchEvent(new CustomEvent('memtree-session-changed', {
            detail: { sessionId: String(sessionId), enabled: next },
          }))
        } catch {
          setEnabled(!next)
        } finally {
          setBusy(false)
        }
      }

      const phase = String(job?.phase ?? '')
      if (phase === 'queued' || phase === 'summarizing' || phase === 'merging'
        || phase === 'waiting-idle' || phase === 'committing') {
        const detail = phase === 'committing'
          ? '写入记忆卡片'
          : String(job.progress ?? (phase === 'waiting-idle' ? '等待空闲提交' : '准备分片'))
        return h('div', {
          style: SS.status,
          'data-memtree-status': phase,
        }, `记忆树压缩中 · ${detail}`)
      }
      let label = enabled ? '本会话使用记忆树' : '本会话已关闭'
      if (!enabled) label += ' · 普通压缩'
      if (phase === 'failed') label += ' · 压缩失败'
      return h('label', {
        style: { ...SS.status, cursor: busy ? 'progress' : 'pointer' },
        title: '只影响当前会话；下一次压缩生效',
      }, [
        h('input', {
          key: 'input',
          type: 'checkbox',
          checked: enabled,
          disabled: busy,
          onChange: toggle,
          style: { margin: 0 },
        }),
        h('span', { key: 'text' }, label),
      ])
    }

    /**
     * Take over the compaction row.
     *
     * The breadcrumb is deliberate: whether this ever runs is the one question a
     * missing card raises, and the browser console is the only place it can be
     * answered after the fact. Registration failures are contained — the shipped
     * row stays.
     * @param {object} ctx client root context.
     * @returns {void}
     */
    function apply(ctx) {
      try {
        console.info(`[memtree] client module loaded (build ${BUILD})`)

        /**
         * Which entries currently occupy the compaction cell, winner first.
         *
         * Exposed on `window.__memtree` and printed once after registration, so
         * "the renderer never ran" can be answered from the page: either this
         * entry is the elected winner (and the transcript holds no compaction
         * node to draw), or it is not (and the election is the problem).
         * @returns {object[]} one row per entry.
         */
        const seats = () => {
          try {
            const entries = ctx.slots.entriesOfSlot?.('conversation.chat.node') ?? []
            return entries.map((entry) => {
              const options = entry?.options ?? entry ?? {}
              return { key: options.key, priority: options.priority, name: options.name }
            }).filter(row => row.key === 'compaction')
          } catch (error) {
            return [{ error: String(error) }]
          }
        }
        try {
          window.__memtree = { build: BUILD, seats }
        } catch {
          // A frozen page global is not worth failing the registration over.
        }

        ctx.slots.inject('conversation.chat.node', () => {
          console.info('[memtree] seat declared, taking over `compaction` at priority -1')
          try {
            const dispose = ctx.slots.register({
              name: 'conversation.chat.node',
              key: 'compaction',
              // A keyed seat rejects a same-priority entry outright:
              // `keyed slot "conversation.chat.node" already has an entry for key
              // "compaction" at priority 0 — register at a different priority to
              // shadow it (lowest renders)`. The shipped row sits at 0, so -1 is
              // what shadows it (subagent uses -10 the same way).
              priority: -1,
            }, MemoryTreeCard)
            queueMicrotask(() => {
              const rows = seats()
              console.info('[memtree] compaction cell now holds:', JSON.stringify(rows))
              if (rows.length > 0 && rows[0]?.priority !== -1) {
                console.warn('[memtree] this build is NOT the winner of the cell:', JSON.stringify(rows[0]))
              }
            })
            return dispose
          } catch (error) {
            // Contained: the shipped row stays and the reason is visible.
            console.error('[memtree] could not shadow the compaction row:', error)
            return () => {}
          }
        })

        // Per-session switch and progress share the stats row. The stats pills
        // sit at order 0 (activity) and 1 (usage); a negative order puts this
        // entry first.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'memory-tree-status',
          order: -100,
        }, MemoryTreeStatus))

        // Settings section: the Host exposes this plugin's Config schema as the
        // `memory-tree` namespace; `configForms` is the browser's form channel.
        const configForms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
        if (configForms !== undefined) {
          try {
            const controller = createSettingsController(configForms.get(SETTINGS_NS))
            ctx.effect(() => () => controller.dispose(), 'memtree: settings form')
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: 'memory-tree',
              order: 55,
              label: '记忆树',
              inject: () => ({
                hooks: { memoryTreeSettings: controller.store },
                save: controller.save,
                resetField: controller.reset,
              }),
            }, MemoryTreeSettings))
          } catch (error) {
            // Settings are additive: a broken page must not take the card down.
            console.error('[memtree] could not mount the settings section:', error)
          }
        }
      } catch (error) {
        console.error('[memtree] failed to take over the compaction seat:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    // Exposed for the offline bundle test; the app never reads them.
    exports.__build = BUILD
    exports.__parseSummary = parseSummary
    exports.__foldSiblings = foldSiblings
    exports.__foldBeforeKeys = foldBeforeKeys
    exports.__collectDescendants = collectDescendants
    return module.exports
  },
})
