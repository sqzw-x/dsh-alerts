/**
 * Integration against a **real cordis Context**.
 *
 * `client.test.mjs` drives the bundle with a hand-written context stub. That is
 * fast and precise, but the stub answers `get()` from a plain map — it cannot
 * say anything about how the framework resolves a service the plugin never
 * declared in `inject`, nor about a plugin registered as a fiber.
 *
 * That gap is exactly where the click-to-navigate bug lived: the plugin handed
 * out `uiWorkspace.openSession` as a detached function, so the service instance
 * was lost and the method threw on `this`. Here the host services are real
 * cordis `Service` instances with prototype methods, registered the way the
 * shipped `UiWorkspaceService` is.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { createHost, currentRow, row } from './harness.mjs'

/** Stand-in for `ui-session`, whose `sessionStatus` store the engine watches. */
class UiSessionService extends Service {
  constructor(ctx, statusStore) {
    super(ctx, 'uiSession')
    this.sessionStatus = statusStore
  }
}

/** Stand-in for `dsh-api-session-controller`: the shipped face has no `open()`. */
class SessionsService extends Service {
  constructor(ctx, listStore) {
    super(ctx, 'sessions')
    this.list = listStore
  }
}

/** Stand-in for the shipped `UiWorkspaceService`: prototype method, reaches `this`. */
class UiWorkspaceService extends Service {
  constructor(ctx, opened) {
    super(ctx, 'uiWorkspace')
    this.opened = opened
    this.lifetime = { signal: null }
  }
  replaceMain(target) {
    this.opened.push(target)
  }
  openSession(target) {
    this.replaceMain(target)
  }
}

/** A real context with those three services, and the navigation log they fill. */
async function realHost() {
  const root = new Context()
  const opened = []
  const host = createHost({
    focused: false,
    context: root,
    setup(ctx, { statusStore, listStore }) {
      new UiSessionService(ctx, statusStore)
      new SessionsService(ctx, listStore)
      new UiWorkspaceService(ctx, opened)
    }
  })
  await host.ready
  host.publishList({ 's-current': currentRow('当前这个对话'), 's-other': row('别的对话') })
  // First non-empty snapshot is the baseline; the second one is what alerts.
  host.publishStatus({ 's-current': { running: false }, 's-other': { running: false } })
  return { opened, host }
}

const wait = (key, sessionId = 's-other') => ({ key, kind: 'approval', sessionId })

test('真实 cordis 宿主：插件作为 fiber 装载，服务照常解析', async () => {
  const { host } = await realHost()
  const debug = host.api.debug()
  assert.equal(debug.bound.sessionStatus, true, 'uiSession 由 inject 等到后绑定')
  assert.equal(debug.bound.sessionList, true)
  assert.equal(debug.navigation, 'uiWorkspace.openSession', '未注入的服务也能 get() 到')
  host.dispose()
})

test('真实 cordis 宿主：点击通知把会话切到 uiWorkspace 上（接收者不丢）', async () => {
  const { opened, host } = await realHost()
  host.publishStatus({
    's-current': { running: false },
    's-other': { running: true, pendingInteraction: wait('approval:real') }
  })
  const notification = host.last()
  assert.ok(notification, '别的会话的等待应该弹出来')

  notification.onclick()
  assert.deepEqual(opened, ['s-other'], '真实服务实例收到了导航调用')
  assert.equal(host.api.debug().counters.failed, 0)
  assert.equal(notification.closed, true)

  host.dispose()
})

test('真实 cordis 宿主：__dshAlerts.open() 走同一条路', async () => {
  const { opened, host } = await realHost()
  assert.equal(host.api.open('s-other'), 'opened')
  assert.equal(host.api.open('s-current'), 'opened')
  assert.deepEqual(opened, ['s-other', 's-current'])
  host.dispose()
})
