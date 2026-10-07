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

/** A session-list row; `currentRow()` marks the conversation on screen. */
export const row = (displayTitle, extra = {}) => ({ displayTitle, retainedBy: {}, ...extra })
export const currentRow = (displayTitle, extra = {}) => row(displayTitle, { retainedBy: { mainView: 1 }, ...extra })

/** Load the built bundle and instantiate the plugin against a fake context. */
export function createHost(options = {}) {
  const protocol = options.protocol ?? 'dsh-app:'
  const statusStore = createStore(new Map())
  const listStore = createStore({ ids: [], byId: {} })
  const opened = []
  const services = {
    uiSession: { sessionStatus: statusStore },
    sessions: { list: listStore, open: (id) => opened.push(id) },
    ...(options.services ?? {})
  }

  const iframes = []
  const intervals = []
  const timeouts = []
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
      timeouts.push({ fn, ms })
      return timeouts.length
    },
    setInterval(fn, ms) {
      intervals.push({ fn, ms })
      return intervals.length
    },
    clearInterval() {},
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
  const ctx = {
    get: (name) => services[name] ?? null,
    reflect: { get: () => null },
    effect(fn) {
      effectCount += 1
      return fn()
    }
  }
  const dispose = plugin.apply(ctx)

  return {
    module: plugin,
    ctx,
    dispose,
    statusStore,
    listStore,
    opened,
    iframes,
    get api() {
      return sandbox.__dshAlerts
    },
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
    }
  }
}
