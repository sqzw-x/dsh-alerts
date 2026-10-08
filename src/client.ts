/**
 * dsh-alerts — browser half (client plugin bundle).
 *
 * The bundle target is `window.__ModuleLoader__.load`, which is what the
 * Harness page's lazy-CJS module table calls; the wrapper around this module is
 * emitted by `tsdown.config.ts`, exactly like the shipped `ui-*` bundles.
 *
 * This half is only glue: it reads the two host stores, asks the engine
 * (`./engine.ts`) what deserves an alert, and posts it. Everything that can be
 * decided without a browser lives in the engine and is unit-tested there.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AlertEngine, type Alert, type AlertConfig, type PendingInteraction } from './engine.ts'
import { VERSION } from './version.ts'

/** Config key in `localStorage`. */
const CONFIG_KEY = 'dshAlerts.config'

const DEFAULTS: AlertConfig = {
  enabled: true,
  ignoreSubagent: true,
  language: 'auto',
  sound: false
}

/** The observable store shape this plugin depends on (getSnapshot + subscribe). */
interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Switch the UI to one conversation. */
type OpenSession = (sessionId: SessionId) => void

/** Where a navigation callable came from; `'none'` means this host cannot switch. */
type NavigationSource = 'sessions.open' | 'uiWorkspace.openSession' | 'none'

/** Services the plugin reads, all resolved lazily so a bare host cannot throw. */
interface HostServices {
  sessionStatus?: Observable<unknown>
  sessionList?: Observable<unknown>
  locale?: { getSnapshot?: () => { active?: string } }
  openSession?: OpenSession
}

/** Runtime surface published as `window.__dshAlerts`. */
interface RuntimeApi {
  version: string
  configure(patch: Partial<AlertConfig>): AlertConfig
  debug(): Record<string, unknown>
  test(kind?: 'attention' | 'done'): string
  /** Switch to a conversation the way a notification click does. */
  open(sessionId?: SessionId): string
}

function isObservable(value: unknown): value is Observable<unknown> {
  const candidate = value as Partial<Observable<unknown>> | null
  return !!candidate && typeof candidate.getSnapshot === 'function' && typeof candidate.subscribe === 'function'
}

/**
 * Services the plugin must wait for before it applies.
 *
 * Only `uiSession` is required, because it carries the store the engine watches.
 * `uiWorkspace` — the navigation owner a notification click needs — is
 * deliberately *not* listed: this half is supposed to keep working on a host
 * that lacks it (an older shell, a bare page), and `ctx.get()` reads a service
 * without the inject requirement anyway. `resolveNavigation()` reports which one
 * a click actually found. The module-level edge that gets the bundle loaded is
 * `dsh.client.inject` in package.json.
 */
export const inject = ['uiSession']

/**
 * Client plugin body. Everything it creates is released by the returned
 * cleanup, so unloading the plugin leaves no subscription, listener or timer.
 */
export function apply(ctx: Context): () => void {
  const scope = ctx as unknown as {
    get(name: string): unknown
    effect?(callback: () => (() => void) | void, label?: string): () => void
  }

  const run = (): (() => void) => start(scope)
  if (typeof scope.effect === 'function') {
    try {
      return scope.effect(run, 'dsh-alerts: notification watchers')
    } catch {
      return run()
    }
  }
  return run()
}

function start(ctx: { get(name: string): unknown }): () => void {
  const config = readConfig()
  const disposers: Array<() => void> = []
  let disposed = false
  let engine: AlertEngine

  /**
   * Resolve the host service that switches conversations, and where it came from.
   *
   * Two candidates, in the order the host is expected to publish them:
   * `sessions.open` (older bridges that bolted navigation onto the session
   * service) and `uiWorkspace.openSession` (the shipped navigation owner).
   *
   * Both are **prototype methods on service instances**, so the resolved
   * callable is bound to its instance. Handing out a detached method loses its
   * receiver: `uiWorkspace.openSession` then throws on `this.replaceMain(...)`,
   * which is exactly how a click on a notification used to navigate nowhere.
   */
  function resolveNavigation(): { source: NavigationSource; open?: OpenSession } {
    try {
      const sessions = ctx.get('sessions') as { open?: unknown } | null
      if (typeof sessions?.open === 'function') {
        return { source: 'sessions.open', open: (sessions.open as OpenSession).bind(sessions) }
      }
      const uiWorkspace = ctx.get('uiWorkspace') as { openSession?: unknown } | null
      if (typeof uiWorkspace?.openSession === 'function') {
        return {
          source: 'uiWorkspace.openSession',
          open: (uiWorkspace.openSession as OpenSession).bind(uiWorkspace)
        }
      }
    } catch { /* a host that publishes neither simply cannot navigate */ }
    return { source: 'none' }
  }

  const services = (): HostServices => {
    const uiSession = ctx.get('uiSession') as { sessionStatus?: unknown } | null
    const sessions = ctx.get('sessions') as { list?: unknown } | null
    const locale = ctx.get('locale') as HostServices['locale'] | null
    return {
      sessionStatus: uiSession?.sessionStatus as Observable<unknown> | undefined,
      sessionList: sessions?.list as Observable<unknown> | undefined,
      locale: locale ?? undefined,
      openSession: resolveNavigation().open
    }
  }

  /** Whether this window has keyboard focus; a host without the API counts as focused. */
  const windowHasFocus = (): boolean => (typeof document.hasFocus === 'function' ? document.hasFocus() : true)

  const resolvedLanguage = (): 'zh' | 'en' => {
    if (config.language === 'zh' || config.language === 'en') return config.language
    const active = services().locale?.getSnapshot?.().active
    const seen = active || document.documentElement?.lang || navigator.language || ''
    return /^zh/i.test(seen) ? 'zh' : 'en'
  }

  engine = new AlertEngine({
    config: () => config,
    focused: windowHasFocus,
    canNotify: () => permission() === 'granted',
    language: resolvedLanguage
  })

  // ── delivery ────────────────────────────────────────────────────────────
  /** Posted notifications still on screen, with the conversation each one is about. */
  const live: Array<{ alert: Alert; notification: Notification }> = []
  const counters = { attention: 0, done: 0, clicked: 0, failed: 0, dismissed: 0 }

  const isDesktopShell = (): boolean => location.protocol === 'dsh-app:'

  /**
   * Bring the OS window forward. A browser tab answers to `window.focus()`; the
   * Electron shell does not, so the desktop rides the app's own `dsh://open`
   * deep link through a hidden iframe (subframe navigation is not caught by the
   * shell's will-navigate handler). Must run inside the click's user gesture,
   * which a notification click carries.
   */
  function raiseWindow(): void {
    try { window.focus() } catch { /* focus is best effort */ }
    if (!isDesktopShell()) return
    try {
      const frame = document.createElement('iframe')
      frame.setAttribute('aria-hidden', 'true')
      frame.setAttribute('tabindex', '-1')
      frame.style.cssText = 'position:fixed;left:-10px;top:-10px;width:0;height:0;border:0;visibility:hidden'
      frame.src = 'dsh://open'
      ;(document.body ?? document.documentElement).appendChild(frame)
      window.setTimeout(() => frame.remove(), 4000)
    } catch { /* a failed raise must never break the click */ }
  }

  /**
   * Switch to the conversation an alert is about — the other half of a click.
   *
   * The service is resolved per call (the host may publish it after this plugin
   * binds) and a failure is *reported*, not swallowed: a click that brings the
   * window forward without switching the conversation is a bug, and a silent
   * `catch` is what let it hide. `debug().counters.failed` counts these.
   */
  function openSession(sessionId: SessionId): boolean {
    const { source, open } = resolveNavigation()
    if (!open) {
      console.warn('[dsh-alerts] this host publishes no navigation service (sessions.open / uiWorkspace.openSession)')
      return false
    }
    try {
      open(sessionId)
      return true
    } catch (error) {
      counters.failed += 1
      console.warn(`[dsh-alerts] ${source} could not switch to session ${sessionId}:`, error)
      return false
    }
  }

  function post(alert: Alert): boolean {
    let notification: Notification
    try {
      notification = new Notification(alert.title, {
        body: alert.body,
        tag: alert.tag,
        silent: true, // the plugin owns sound (config.sound)
        icon: `${location.origin}/favicon.svg`
      })
    } catch {
      return false
    }
    const entry = { alert, notification }
    notification.onclick = () => {
      counters.clicked += 1
      raiseWindow()
      openSession(alert.sessionId)
      try { notification.close() } catch { /* already gone */ }
      // Coming back through the notification reads the conversation too: anything
      // still on screen for it (an older tag, a race with the click) goes away.
      dismissSession(alert.sessionId)
    }
    notification.onclose = () => {
      const index = live.indexOf(entry)
      if (index >= 0) live.splice(index, 1)
    }
    live.push(entry)
    if (live.length > 20) live.splice(0, live.length - 20)
    if (config.sound) chime(alert.kind)
    if (alert.kind === 'attention') counters.attention += 1
    else counters.done += 1
    return true
  }

  /**
   * Close the notification of a conversation you have just returned to.
   *
   * An alert exists to pull you into a conversation you are not looking at, so it
   * has done its job the moment that conversation is back on screen — whether you
   * switched to it by hand or arrived through the notification's own click. This
   * is also the only way to clear it on macOS, where toasts stay in the
   * Notification Center until they are explicitly closed.
   */
  function dismissSession(sessionId: SessionId): void {
    for (const entry of [...live]) {
      if (entry.alert.sessionId !== sessionId) continue
      try { entry.notification.close() } catch { /* already gone */ }
      const index = live.indexOf(entry)
      if (index >= 0) live.splice(index, 1)
      counters.dismissed += 1
    }
  }

  /** Reading a conversation is what retires its alert; a blurred window reads nothing. */
  function dismissCurrent(): void {
    if (disposed || !windowHasFocus()) return
    const current = engine.currentSessionId()
    if (current !== null) dismissSession(current)
  }

  function deliver(alerts: Alert[]): void {
    for (const alert of alerts) if (post(alert)) notify(alert)
  }

  function notify(alert: Alert): void {
    try {
      window.dispatchEvent(new CustomEvent('dsh-alerts:alert', { detail: alert }))
    } catch { /* the event is a convenience, not a contract */ }
  }

  // ── binding ─────────────────────────────────────────────────────────────
  let statusSub: (() => void) | null = null
  let listSub: (() => void) | null = null

  function bind(): void {
    if (disposed) return
    const resolved = services()
    if (!statusSub && isObservable(resolved.sessionStatus)) {
      const store = resolved.sessionStatus
      const sync = (): void => {
        deliver(engine.onStatus(store.getSnapshot() as never))
        dismissCurrent()
      }
      statusSub = store.subscribe(sync)
      disposers.push(() => statusSub?.())
      sync()
    }
    if (!listSub && isObservable(resolved.sessionList)) {
      const store = resolved.sessionList
      const sync = (): void => {
        engine.onList(store.getSnapshot() as never)
        // Switching conversations is the manual way back to one: the moment the
        // one you return to becomes the one on screen, its alert is spent.
        dismissCurrent()
      }
      listSub = store.subscribe(sync)
      disposers.push(() => listSub?.())
      sync()
    }
  }

  /** Losing focus is what makes the on-screen conversation's wait eligible. */
  const onAway = (): void => { if (!disposed) deliver(engine.replay()) }

  /** Regaining focus (or the page coming back) is the manual way back. */
  const onBack = (): void => { if (!disposed) dismissCurrent() }

  const onGesture = (): void => { unlockAudio(); requestPermission() }

  function requestPermission(): void {
    try {
      if (!('Notification' in window)) return
      if (Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined)
    } catch { /* a denied or unsupported channel stays silent */ }
  }

  bind()
  // The uiSession / sessions entries may activate after this one; retry cheaply
  // instead of gating activation on them.
  const retry = window.setInterval(bind, 1500)
  disposers.push(() => window.clearInterval(retry))

  window.addEventListener('blur', onAway)
  // `focus` is the window's own event and fires in every engine; the document
  // listener is the fallback for hosts that only report visibility.
  window.addEventListener('focus', onBack)
  document.addEventListener('visibilitychange', onAway)
  document.addEventListener('visibilitychange', onBack)
  window.addEventListener('pointerdown', onGesture)
  window.addEventListener('keydown', onGesture)
  disposers.push(() => {
    window.removeEventListener('blur', onAway)
    window.removeEventListener('focus', onBack)
    document.removeEventListener('visibilitychange', onAway)
    document.removeEventListener('visibilitychange', onBack)
    window.removeEventListener('pointerdown', onGesture)
    window.removeEventListener('keydown', onGesture)
  })
  window.setTimeout(requestPermission, 3000)

  // ── runtime API ─────────────────────────────────────────────────────────
  const api: RuntimeApi = {
    version: VERSION,
    configure(patch) {
      Object.assign(config, sanitize(patch))
      persist()
      return { ...config }
    },
    debug() {
      const resolved = services()
      return {
        version: VERSION,
        bound: { sessionStatus: !!statusSub, sessionList: !!listSub },
        permission: permission(),
        focused: windowHasFocus(),
        language: resolvedLanguage(),
        desktopShell: isDesktopShell(),
        // Which host service a notification click would navigate through:
        // `'none'` explains a click that raises the window but switches nothing.
        navigation: resolveNavigation().source,
        config: { ...config },
        counters: { ...counters },
        ...engine.snapshot()
      }
    },
    test(kind = 'attention') {
      const sessionId = engine.currentSessionId() ?? ('test' as SessionId)
      const alert = engine.forced(kind, sessionId)
      return post(alert) ? 'sent' : `not sent (permission=${permission()})`
    },
    open(sessionId) {
      const target = sessionId ?? engine.currentSessionId()
      if (target === null) return 'no session to open'
      return openSession(target) ? 'opened' : `not opened (navigation=${resolveNavigation().source}, see console)`
    }
  }
  ;(window as unknown as { __dshAlerts?: RuntimeApi }).__dshAlerts = api

  return () => {
    disposed = true
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* teardown must not throw */ }
    }
    if ((window as unknown as { __dshAlerts?: RuntimeApi }).__dshAlerts === api) {
      delete (window as unknown as { __dshAlerts?: RuntimeApi }).__dshAlerts
    }
    live.splice(0)
  }
}

// ── config ────────────────────────────────────────────────────────────────
function readConfig(): AlertConfig {
  const stored: Partial<AlertConfig> = {}
  try {
    const raw = window.localStorage?.getItem(CONFIG_KEY)
    if (raw) Object.assign(stored, JSON.parse(raw) as Partial<AlertConfig>)
  } catch { /* corrupt or unavailable storage falls back to defaults */ }
  return { ...DEFAULTS, ...sanitize(stored) }
}

function sanitize(patch: Partial<AlertConfig>): Partial<AlertConfig> {
  const clean: Partial<AlertConfig> = {}
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
  if (typeof patch.ignoreSubagent === 'boolean') clean.ignoreSubagent = patch.ignoreSubagent
  if (typeof patch.sound === 'boolean') clean.sound = patch.sound
  if (patch.language === 'auto' || patch.language === 'zh' || patch.language === 'en') clean.language = patch.language
  return clean
}

function persist(): void {
  try {
    window.localStorage?.setItem(CONFIG_KEY, JSON.stringify(readConfig()))
  } catch { /* storage is optional */ }
}

function permission(): string {
  try {
    return 'Notification' in window ? Notification.permission : 'unsupported'
  } catch {
    return 'unsupported'
  }
}

// ── optional chime ────────────────────────────────────────────────────────
let audioContext: AudioContext | null = null

function unlockAudio(): void {
  try {
    const Ctor = window.AudioContext
    if (!Ctor) return
    audioContext ??= new Ctor()
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => undefined)
  } catch { /* no audio is not an error */ }
}

function chime(kind: Alert['kind']): void {
  try {
    if (!audioContext || audioContext.state !== 'running') return
    const start = audioContext.currentTime
    const notes = kind === 'attention' ? [880, 1174] : [659]
    notes.forEach((frequency, index) => {
      const oscillator = audioContext!.createOscillator()
      const gain = audioContext!.createGain()
      const at = start + index * 0.16
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18)
      oscillator.connect(gain).connect(audioContext!.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.2)
    })
  } catch { /* a silent chime never breaks an alert */ }
}

/** Re-exported for the type-only consumers of this bundle. */
export type { Alert, AlertConfig, PendingInteraction }
