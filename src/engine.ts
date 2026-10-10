/**
 * The notification rules, as pure logic.
 *
 * This module owns everything that can be decided without a browser: which
 * events exist, which of them deserve an alert, and what that alert says. The
 * client half (`./client.ts`) only feeds it snapshots and posts what it returns,
 * which keeps the interesting behaviour unit-testable without a DOM.
 *
 * The rules, in full:
 *
 *   1. Every event is delivered by the same path. A pending interaction
 *      (approval / plan review / question) and a finished reply differ only in
 *      their copy.
 *   2. The conversation on screen alerts **only once its window loses focus**.
 *      An alert withheld by that rule is not lost: it stays queued and is
 *      replayed when the window loses focus, as long as the wait is still open.
 *   3. Every other conversation alerts **at any time**, focused or not.
 *   4. Subagent sessions never alert.
 *
 * One deliberate asymmetry: an *unfocused* window cannot tell whether you are
 * reading the conversation or working somewhere else, so the third rule wins —
 * background conversations always alert. Only the conversation you actually
 * have on screen is treated as "already seen".
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'

/** Two collapsed views of the same thing: something needs you, or something finished. */
export type AlertKind = 'attention' | 'done'

/** One notification to post. */
export interface Alert {
  kind: AlertKind
  sessionId: SessionId
  /** Notification title, e.g. `DSH · 需要你`. */
  title: string
  /** Notification body, e.g. `重构登录流程 · 审批请求`. */
  body: string
  /** One tag per conversation, so a newer event replaces the older notification. */
  tag: string
}

/** User-facing switches. */
export interface AlertConfig {
  /** Master switch; off means the engine watches but never returns an alert. */
  enabled: boolean
  /** Background subagent sessions never alert. */
  ignoreSubagent: boolean
  /** Copy language. */
  language: 'auto' | 'zh' | 'en'
  /** Optional WebAudio chime on top of the system notification. */
  sound: boolean
}

/** Everything the engine needs from its host. */
export interface EngineDeps {
  /** Live config (read on every decision, so a switch applies immediately). */
  config(): AlertConfig
  /** Whether this window currently has keyboard focus. */
  focused(): boolean
  /** Whether the platform would actually show a notification right now. */
  canNotify(): boolean
  /** Copy language, already resolved to a shipped dictionary. */
  language(): 'zh' | 'en'
  /** Injectable clock, for tests. */
  now?(): number
}

/** A pending interaction as the session store exposes it. */
export interface PendingInteraction {
  readonly key: string
  readonly kind: string
  readonly sessionId: SessionId
}

/** What `debug()` reports. */
export interface EngineSnapshot {
  currentSession: SessionId | null
  trackedSessions: SessionId[]
  openWaits: { sessionId: SessionId; key: string; kind: string }[]
  deliveredKeys: string[]
  subagentSessions: SessionId[]
}

const COPY = {
  zh: {
    waitTitle: 'DSH · 需要你',
    doneTitle: 'DSH · 回复完成',
    doneBody: '回复已完成',
    current: '当前对话',
    kind: {
      approval: '审批请求',
      'plan-review': '方案待确认',
      question: '提问'
    } as Record<string, string>,
    kindDefault: '需要操作'
  },
  en: {
    waitTitle: 'DSH · You are needed',
    doneTitle: 'DSH · Reply finished',
    doneBody: 'the reply has finished',
    current: 'current conversation',
    kind: {
      approval: 'approval request',
      'plan-review': 'plan review',
      question: 'question'
    } as Record<string, string>,
    kindDefault: 'action needed'
  }
} as const

/** Two host views of the same completion can land in one tick; collapse them. */
const DONE_COALESCE_MS = 300

/**
 * Derives alerts from the two host stores.
 *
 * Feed it `onList()` and `onStatus()` snapshots, post what they return, and call
 * `replay()` when the window loses focus.
 */
export class AlertEngine {
  private readonly statuses = new Map<SessionId, { running: boolean; pendingKey: string | null }>()
  private readonly pending = new Map<SessionId, PendingInteraction>()
  private readonly delivered = new Set<string>()
  private readonly lastDone = new Map<SessionId, number>()
  private readonly labels = new Map<SessionId, string>()
  private readonly subagents = new Set<SessionId>()
  /** Session ids from the last list snapshot, so a subagent record is only dropped
   *  once neither snapshot mentions it any more. */
  private listIds = new Set<SessionId>()
  private currentId: SessionId | null = null
  private seeded = false

  constructor(private readonly deps: EngineDeps) {}

  /** The conversation the UI currently has open, derived from `mainView` retention. */
  currentSessionId(): SessionId | null {
    return this.currentId
  }

  /** The complete rule set — the only place a delivery decision is made. */
  allows(sessionId: SessionId): boolean {
    const config = this.deps.config()
    if (!config.enabled) return false
    if (!this.deps.canNotify()) return false
    if (config.ignoreSubagent && this.subagents.has(sessionId)) return false
    // The conversation on screen is treated as read the moment the window has
    // focus; every other conversation is news whenever it happens.
    if (this.currentId !== null && sessionId === this.currentId) return !this.deps.focused()
    return true
  }

  /** Ingest a session-list snapshot: labels, subagent rows, the session on screen. */
  onList(state: SessionListState | undefined | null): void {
    if (!state?.byId) return
    const rows = Object.entries(state.byId) as Array<[SessionId, SessionSummary | undefined]>
    const ids = new Set<SessionId>()
    let firstMain: SessionId | null = null
    let held: SessionId | null = null
    for (const [sid, row] of rows) {
      const summary = row as
        | { displayTitle?: string; title?: string; origin?: string; retainedBy?: Record<string, number> }
        | undefined
      if (!summary) continue
      ids.add(sid)
      this.labels.set(sid, summary.displayTitle || summary.title || String(sid))
      if (summary.origin === 'subagent') this.subagents.add(sid)
      else this.subagents.delete(sid)
      // `mainView` is the retention source the conversation view holds; on
      // hosts where the list used to carry a `current` field this is the only
      // remaining signal for "the conversation on screen".
      if ((summary.retainedBy?.mainView ?? 0) > 0) {
        if (firstMain === null) firstMain = sid
        if (sid === this.currentId) held = sid
      }
    }
    // The three rules upstream `publishMain` applies, as far as a list snapshot
    // can express them:
    //   1. keep the session we already have while its row still holds `mainView`;
    //   2. otherwise the FIRST row with a live `mainView` retention;
    //   3. otherwise nothing is on screen.
    // (This used to be a running assignment, which stuck to the last match and
    // never let go — hence both the fallback and the clear-to-null.)
    //
    // The one place this cannot match upstream exactly is a held session whose
    // row is absent from this snapshot: upstream asks the retention store, which
    // can still hold a scope without a row, while a snapshot is all we see. The
    // engine therefore treats "no row" as "not on screen" — the same answer it
    // gives for a session the view has released, which is the case that matters
    // here. Keeping an absent id instead would restore the stickiness this fixes.
    this.currentId = held ?? firstMain
    this.listIds = ids
    for (const sid of [...this.labels.keys()]) if (!ids.has(sid)) this.labels.delete(sid)
  }

  /**
   * Ingest a session-status snapshot and return the alerts it produced.
   *
   * The first non-empty snapshot only establishes baselines: a page reload must
   * not replay alerts for state that already existed.
   */
  onStatus(snapshot: SessionStatusSnapshot | undefined | null): Alert[] {
    if (!snapshot || typeof snapshot.forEach !== 'function') return []
    const alerts: Alert[] = []
    const seen = new Set<SessionId>()

    snapshot.forEach((status, sid) => {
      seen.add(sid)
      const pending = (status?.pendingInteraction ?? null) as PendingInteraction | null
      const key = pending?.key ?? `${pending?.kind ?? 'wait'}:${sid}`
      const running = status?.running === true
      const previous = this.statuses.get(sid)

      if (pending) this.pending.set(sid, pending)
      else this.pending.delete(sid)

      // "A delivered key is released as soon as it stops being *the* key for its
      // session — answered, or replaced by a newer request; the ledger holds at
      // most one key per session." A replacement matters too: the host may swap
      // a pending request for a new key with the previous one never going
      // absent, and the old key would otherwise stay in the ledger forever.
      if (previous?.pendingKey && previous.pendingKey !== (pending ? key : null)) {
        this.delivered.delete(previous.pendingKey)
      }

      if (!this.seeded) {
        // Baseline: a wait that already existed when the plugin bound is state,
        // not news.
        if (pending) this.delivered.add(key)
      } else {
        // A wait whose key has not been delivered yet, and that the rules allow.
        // A withheld alert keeps its key unmarked so `replay()` can deliver it.
        if (pending && !this.delivered.has(key) && this.allows(sid)) {
          this.delivered.add(key)
          alerts.push(this.waitAlert(sid, pending))
        }
        // A completion: running fell with no wait taking its place — a stop that
        // awaits input is a wait, not a completion.
        if (previous?.running === true && !running && !pending) {
          const now = this.now()
          if (now - (this.lastDone.get(sid) ?? 0) > DONE_COALESCE_MS) {
            this.lastDone.set(sid, now)
            if (this.allows(sid)) alerts.push(this.doneAlert(sid))
          }
        }
      }

      this.statuses.set(sid, { running, pendingKey: pending ? key : null })
    })

    for (const sid of [...this.statuses.keys()]) {
      if (seen.has(sid)) continue
      const gone = this.statuses.get(sid)
      if (gone?.pendingKey) this.delivered.delete(gone.pendingKey)
      this.statuses.delete(sid)
      this.pending.delete(sid)
      this.lastDone.delete(sid)
      // Subagent records follow the session out, but only once the list snapshot
      // has dropped it too — a row that is merely late in the status store still
      // has to be recognised as a subagent when it arrives.
      if (!this.listIds.has(sid)) this.subagents.delete(sid)
    }

    if (!this.seeded && seen.size > 0) this.seeded = true
    return alerts
  }

  /**
   * Alerts for open waits that were withheld earlier and are allowed now —
   * called when the window loses focus or the page is backgrounded.
   */
  replay(): Alert[] {
    const alerts: Alert[] = []
    for (const [sid, pending] of this.pending) {
      if (this.delivered.has(pending.key)) continue
      if (!this.allows(sid)) continue
      this.delivered.add(pending.key)
      alerts.push(this.waitAlert(sid, pending))
    }
    return alerts
  }

  /** Build an alert regardless of the rules — used by the plugin's test button. */
  forced(kind: AlertKind, sessionId: SessionId, pending?: PendingInteraction): Alert {
    if (kind === 'done') return this.doneAlert(sessionId)
    return this.waitAlert(sessionId, pending ?? { key: 'test', kind: 'approval', sessionId })
  }

  /** Live state for `window.__dshAlerts.debug()`. */
  snapshot(): EngineSnapshot {
    return {
      currentSession: this.currentId,
      trackedSessions: [...this.statuses.keys()],
      openWaits: [...this.pending].map(([sessionId, p]) => ({ sessionId, key: p.key, kind: p.kind })),
      deliveredKeys: [...this.delivered],
      subagentSessions: [...this.subagents]
    }
  }

  /** True once a non-empty status snapshot has been seen. */
  get ready(): boolean {
    return this.seeded
  }

  private label(sessionId: SessionId): string {
    return this.labels.get(sessionId) ?? (sessionId === this.currentId ? COPY[this.deps.language()].current : String(sessionId))
  }

  private waitAlert(sessionId: SessionId, pending: PendingInteraction): Alert {
    const copy = COPY[this.deps.language()]
    const what = copy.kind[pending.kind] ?? copy.kindDefault
    return {
      kind: 'attention',
      sessionId,
      title: copy.waitTitle,
      body: `${this.label(sessionId)} · ${what}`,
      tag: `dsh-alerts:${sessionId}`
    }
  }

  private doneAlert(sessionId: SessionId): Alert {
    const copy = COPY[this.deps.language()]
    return {
      kind: 'done',
      sessionId,
      title: copy.doneTitle,
      body: `${this.label(sessionId)} · ${copy.doneBody}`,
      tag: `dsh-alerts:${sessionId}`
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
