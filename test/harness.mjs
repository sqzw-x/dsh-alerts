/**
 * Test harness: runs the **built** `lib/client.js` the way the Harness page
 * does — through `window.__ModuleLoader__.load` inside a vm context — and hands
 * the test a fake host with the two stores this plugin watches.
 *
 * The rules themselves are covered by `engine.test.mjs` against the typed
 * engine; these helpers exist to prove the bundle contract and the wiring
 * (subscriptions, focus handling, click-to-open, teardown).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = readFileSync(BUNDLE, 'utf8')

/** Recording stand-in for the browser Notification constructor. */
export class FakeNotification {
  static instances = []
  static permission = 'granted'
  static requestPermission() {
    return Promise.resolve('granted')
  }
  static reset() {
    FakeNotification.instances = []
    FakeNotification.permission = 'granted'
  }
  constructor(title, options) {
    this.title = title
    this.options = options ?? {}
    this.closed = false
    FakeNotification.instances.push(this)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
}

/** Minimal observable store with the shape the Harness publishes. */
export function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(next) {
      value = next
      for (const listener of [...listeners]) listener(value)
    },
    get listenerCount() {
      return listeners.size
    }
  }
}

/**
 * A session-list row; `currentRow()` marks the conversation on screen.
 *
 * `extra` carries along the fields a real row would keep across republishes
 * (title, origin, …); the retention field itself stays owned by the caller.
 */
export const row = (displayTitle, extra = {}) =>
  ({ ...extra, displayTitle, retainedBy: {} })
export const currentRow = (displayTitle, extra = {}) =>
  ({ ...extra, displayTitle, retainedBy: { mainView: 1 } })

/**
 * The shipped navigation owner, with the shape that matters: `UiWorkspaceService`
 * is a class instance whose `openSession` is a **prototype method** reaching its
 * peer through `this`. Passed to a plugin as a detached function it throws —
 * which is what the default `sessions` face leaves as the only option.
 */
export class FakeUiWorkspace {
  constructor(opened, options = {}) {
    this.opened = opened
    this.throwing = options.throwing === true
    this.lifetime = { signal: null }
  }
  replaceMain(target) {
    if (this.throwing) throw new Error('navigation exploded')
    this.opened.push(target)
  }
  openSession(target) {
    this.replaceMain(target)
  }
}

/** Older bridge that bolted navigation onto the session service; also `this`-reaching. */
export class FakeSessions {
  constructor(list, opened) {
    this.list = list
    this.opened = opened
  }
  open(target) {
    this.opened.push(target)
  }
}

/** Load the built bundle and instantiate the plugin against a fake context. */
export function createHost(options = {}) {
  const protocol = options.protocol ?? 'dsh-app:'
  const statusStore = createStore(new Map())
  const listStore = createStore({ ids: [], byId: {} })
  const opened = []
  // Which navigation service the host publishes: the shipped `uiWorkspace` by
  // default, the legacy `sessions.open` on request, neither, or a failing one.
  const navigation = options.navigation ?? 'uiWorkspace'
  const services = {
    uiSession: { sessionStatus: statusStore },
    // The shipped `ISessions` face has no `open()`; that is why the plugin has
    // to fall through to `uiWorkspace.openSession` in the first place.
    sessions: navigation === 'sessions' ? new FakeSessions(listStore, opened) : { list: listStore },
    ...(navigation === 'none' ? {} : { uiWorkspace: new FakeUiWorkspace(opened, { throwing: navigation === 'throwing' }) }),
    ...(options.services ?? {})
  }

  const iframes = []
  /**
   * Scheduled-timer bookkeeping. These hold *handle ids* (what the bundle gets
   * back from `setTimeout` / `setInterval`), so a test can assert that teardown
   * cleared the very timer it scheduled. One counter serves both kinds, which is
   * what makes an id unique across them — exactly as on a real host.
   */
  const timeouts = []
  const intervals = []
  const clearedTimeouts = []
  const clearedIntervals = []
  const timeoutHandlers = []
  const intervalHandlers = []
  let nextTimerId = 0
  const listeners = new Map()
  const documentListeners = new Map()
  let focused = options.focused ?? true
  let focusCalls = 0
  let effectCount = 0
  let loaded = null

  const add = (map) => (type, handler) => {
    const set = map.get(type) ?? new Set()
    set.add(handler)
    map.set(type, set)
  }
  const remove = (map) => (type, handler) => map.get(type)?.delete(handler)

  const documentStub = {
    documentElement: { lang: options.lang ?? 'zh' },
    hasFocus: () => focused,
    createElement() {
      const node = {
        tagName: 'iframe',
        src: '',
        style: {},
        attributes: {},
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        remove() {
          this.parentNode = null
        }
      }
      iframes.push(node)
      return node
    },
    body: {
      appendChild(node) {
        node.parentNode = this
      }
    },
    addEventListener: add(documentListeners),
    removeEventListener: remove(documentListeners)
  }

  const sandbox = {
    console,
    document: documentStub,
    Notification: options.notificationClass ?? FakeNotification,
    navigator: { language: options.navigatorLanguage ?? 'zh-CN' },
    location: {
      origin: protocol === 'dsh-app:' ? 'dsh-app://app' : 'http://127.0.0.1:19387',
      protocol,
      href: `${protocol}//app`
    },
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null
      },
      setItem(key, value) {
        this.store.set(key, String(value))
      }
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
    dispatchEvent: () => true,
    addEventListener: add(listeners),
    removeEventListener: remove(listeners),
    focus() {
      focusCalls += 1
    },
    setTimeout(fn, ms) {
      const handle = ++nextTimerId
      timeouts.push(handle)
      timeoutHandlers.push({ handle, fn, ms })
      return handle
    },
    setInterval(fn, ms) {
      const handle = ++nextTimerId
      intervals.push(handle)
      intervalHandlers.push({ handle, fn, ms })
      return handle
    },
    clearInterval(handle) {
      clearedIntervals.push(handle)
    },
    // The bundle clears one-shot timers on teardown. Without this the sandbox
    // throws inside those disposers and the per-disposer try/catch swallows it,
    // so no test could tell whether teardown actually cleaned up.
    clearTimeout(handle) {
      clearedTimeouts.push(handle)
    },
    __ModuleLoader__: {
      load(spec) {
        loaded = spec
      }
    }
  }
  sandbox.window = sandbox

  const context = vm.createContext(sandbox)
  vm.runInContext(SOURCE, context, { filename: 'lib/client.js' })
  if (!loaded) throw new Error('bundle did not register a module factory')
  if (loaded.id !== 'dsh-alerts') throw new Error(`unexpected module id: ${loaded.id}`)

  const plugin = loaded.factory()
  // A real cordis Context, when the caller brings one: the fake below answers
  // `get()` from a plain map, which cannot show how the framework resolves a
  // service the plugin never injected.
  const ctx = options.context ?? {
    get: (name) => services[name] ?? null,
    reflect: { get: () => null },
    effect(fn) {
      effectCount += 1
      return fn()
    }
  }
  if (options.context) options.setup?.(ctx, { statusStore, listStore, sandbox })
  // Registering through cordis is what applies `inject` and owns the teardown;
  // the fake context takes the plugin's own returned disposer instead.
  const fiber = options.context
    ? ctx.plugin({ name: 'dsh-alerts', inject: plugin.inject, apply: plugin.apply })
    : null
  const dispose = fiber === null ? plugin.apply(ctx) : () => void fiber.dispose()
  // A cordis fiber activates on its own schedule, so `apply` may not have run
  // when this function returns; awaiting `ready` is how a real-context test
  // waits for the plugin to be up.
  const readiness = fiber === null ? Promise.resolve() : Promise.resolve(fiber).then(() => undefined)

  return {
    module: plugin,
    ctx,
    dispose,
    statusStore,
    listStore,
    opened,
    iframes,
    timeouts,
    intervals,
    clearedTimeouts,
    clearedIntervals,
    timeoutHandlers,
    intervalHandlers,
    get api() {
      return sandbox.__dshAlerts
    },
    /** Resolves once the plugin is applied (a cordis fiber activates asynchronously). */
    ready: readiness,
    notifications: () => FakeNotification.instances,
    last: () => FakeNotification.instances.at(-1),
    setFocus(next) {
      focused = next
    },
    get focusCalls() {
      return focusCalls
    },
    get effectCount() {
      return effectCount
    },
    /** Fire a window event the plugin listens for (blur, pointerdown, ...). */
    fireWindow(type) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler({ type })
    },
    /** Fire a document event (visibilitychange). */
    fireDocument(type) {
      for (const handler of [...(documentListeners.get(type) ?? [])]) handler({ type })
    },
    publishStatus(entries) {
      statusStore.publish(new Map(Object.entries(entries)))
    },
    publishList(rows) {
      listStore.publish({ ids: Object.keys(rows), byId: rows })
    },
    /**
     * Republish the session list with a different conversation retained by the
     * main view — what the host does when you switch conversations by hand.
     */
    switchTo(sessionId) {
      const state = listStore.getSnapshot()
      const byId = {}
      for (const [id, entry] of Object.entries(state.byId)) {
        byId[id] = id === sessionId ? currentRow(entry.displayTitle, entry) : row(entry.displayTitle, entry)
      }
      this.publishList(byId)
    }
  }
}
