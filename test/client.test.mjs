/**
 * Bundle-level tests: the built `lib/client.js` loaded through
 * `window.__ModuleLoader__.load`, driven against a fake host.
 *
 * The decision table itself is covered by `engine.test.mjs`; what these verify
 * is the contract with the Harness page and the wiring around the engine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeNotification, createHost, currentRow, row } from './harness.mjs'

/** A host with one conversation on screen, one in the background, one subagent. */
function makeHost(options = {}) {
  FakeNotification.reset()
  FakeNotification.permission = options.permission ?? 'granted'
  const host = createHost(options)
  host.publishList({
    's-current': currentRow('当前这个对话'),
    's-other': row('别的对话'),
    's-sub': row('子代理步骤', { origin: 'subagent' })
  })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: false, pendingInteraction: undefined },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  return host
}

const wait = (key, kind = 'approval', sessionId = 's-other') => ({ key, kind, sessionId })

test('产物契约：模块 id、apply / inject 导出', () => {
  const host = createHost()
  assert.equal(host.module.inject?.includes('uiSession'), true)
  assert.equal(typeof host.module.apply, 'function')
  assert.equal(typeof host.api?.debug, 'function')
  assert.equal(typeof host.api?.configure, 'function')
  assert.equal(typeof host.api?.test, 'function')
})

test('非当前会话的等待：窗口有焦点也弹', () => {
  const host = makeHost({ focused: true })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: true, pendingInteraction: wait('approval:1') },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  assert.equal(host.notifications().length, 1)
  assert.equal(host.last().title, 'DSH · 需要你')
  assert.equal(host.last().options.tag, 'dsh-alerts:s-other')
  assert.equal(host.last().options.silent, true, '声音由插件自己负责')
})

test('当前会话：有焦点不弹，失焦事件后补弹', () => {
  const host = makeHost({ focused: true })
  host.publishStatus({
    's-current': { running: true, pendingInteraction: wait('approval:cur', 'question', 's-current') },
    's-other': { running: false, pendingInteraction: undefined },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  assert.equal(host.notifications().length, 0, '有焦点时不该打扰')

  host.setFocus(false)
  host.fireWindow('blur')
  assert.equal(host.notifications().length, 1, '失焦后补上这条')
  assert.equal(host.last().options.body, '当前这个对话 · 提问')
})

test('窗口重新聚焦后，页面隐藏事件也能补弹', () => {
  const host = makeHost({ focused: true })
  host.publishStatus({
    's-current': { running: true, pendingInteraction: wait('approval:cur', 'plan-review', 's-current') },
    's-other': { running: false, pendingInteraction: undefined },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  assert.equal(host.notifications().length, 0)
  host.setFocus(false)
  host.fireDocument('visibilitychange')
  assert.equal(host.notifications().length, 1)
})

test('子代理会话：两个维度都不弹', () => {
  const host = makeHost({ focused: false })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: false, pendingInteraction: undefined },
    's-sub': { running: true, pendingInteraction: wait('approval:sub', 'approval', 's-sub') }
  })
  assert.equal(host.notifications().length, 0)
})

test('点击通知：抬窗 + 切到该会话 + 关掉通知', () => {
  const host = makeHost({ focused: false })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: true, pendingInteraction: wait('approval:click') },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  const notification = host.last()
  notification.onclick()
  assert.equal(host.focusCalls, 1, 'window.focus()')
  assert.deepEqual(host.opened, ['s-other'], '切到提醒的那个会话')
  assert.equal(host.iframes[0]?.src, 'dsh://open', '桌面端发 dsh:// 深链')
  assert.equal(notification.closed, true, '点完关掉通知')
})

test('浏览器环境不发深链', () => {
  const host = makeHost({ protocol: 'http:', focused: false })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: true, pendingInteraction: wait('approval:web') },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  host.last().onclick()
  assert.equal(host.iframes.length, 0)
  assert.deepEqual(host.opened, ['s-other'])
})

test('手动切回窗口：当前会话的通知自动消除', () => {
  const host = makeHost({ focused: true })
  host.publishStatus({
    's-current': { running: true, pendingInteraction: wait('approval:cur', 'question', 's-current') },
    's-other': { running: false, pendingInteraction: undefined },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  host.setFocus(false)
  host.fireWindow('blur')
  const notification = host.last()
  assert.equal(notification.closed, false, '失焦补弹的通知先留着')

  host.setFocus(true)
  host.fireWindow('focus')
  assert.equal(notification.closed, true, '切回来就该收掉')
  assert.equal(host.api.debug().counters.dismissed, 1)

  // 回到这个会话不该再补弹一次
  host.setFocus(false)
  host.fireWindow('blur')
  assert.equal(host.notifications().length, 1, '读过的提醒不再重放')
})

test('手动切回会话：切到哪个会话就消掉哪个的通知', () => {
  const host = makeHost({ focused: true })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: true, pendingInteraction: wait('approval:other') },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  const notification = host.last()
  assert.equal(notification.options.tag, 'dsh-alerts:s-other', '别的会话的等待')
  assert.equal(notification.closed, false)

  host.switchTo('s-other')
  assert.equal(host.api.debug().currentSession, 's-other')
  assert.equal(notification.closed, true, '切过去的那个会话的通知被收掉')

  host.switchTo('s-current')
  assert.equal(host.api.debug().currentSession, 's-current')
  assert.equal(notification.closed, true, '后来又切走，也不会把它变回未读')
})

test('窗口失焦时切到某个会话，不该顺手消掉它的通知', () => {
  const host = makeHost({ focused: false })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: true, pendingInteraction: wait('approval:blurred') },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  host.switchTo('s-other')
  assert.equal(host.last().closed, false, '人不在窗口前，通知还得留着')
})

test('关掉总开关后切回会话：不弹也不残留', () => {
  const host = makeHost({ focused: true })
  host.api.configure({ enabled: false })
  host.publishStatus({
    's-current': { running: false, pendingInteraction: undefined },
    's-other': { running: true, pendingInteraction: wait('approval:off') },
    's-sub': { running: false, pendingInteraction: undefined }
  })
  assert.equal(host.notifications().length, 0)
  host.switchTo('s-other')
  host.fireWindow('focus')
  assert.equal(host.api.debug().counters.dismissed, 0, '没有通知就别记数')
})

test('卸载：退订、摘掉运行时 API、不再弹', () => {
  const host = makeHost({ focused: false })
  assert.equal(host.effectCount, 1, '整个插件挂在一个 effect 里')
  assert.equal(host.statusStore.listenerCount, 1)
  assert.equal(host.listStore.listenerCount, 1)
  host.dispose()
  assert.equal(host.statusStore.listenerCount, 0)
  assert.equal(host.listStore.listenerCount, 0)
  assert.equal(host.api, undefined, 'window.__dshAlerts 应当被摘掉')
  host.publishStatus({
    's-other': { running: true, pendingInteraction: wait('approval:late') }
  })
  assert.equal(host.notifications().length, 0)
})

test('权限未授予时不弹；configure() 关掉后也不弹', () => {
  const denied = makeHost({ focused: false, permission: 'denied' })
  denied.publishStatus({ 's-other': { running: true, pendingInteraction: wait('approval:denied') } })
  assert.equal(denied.notifications().length, 0)

  const host = makeHost({ focused: false })
  host.api.configure({ enabled: false })
  host.publishStatus({ 's-other': { running: true, pendingInteraction: wait('approval:off') } })
  assert.equal(host.notifications().length, 0)
  assert.equal(host.api.debug().config.enabled, false)
})

test('debug() 报告绑定状态、当前会话与开关', () => {
  const host = makeHost({ focused: false })
  const debug = host.api.debug()
  // 逐字段比较：debug() 的对象来自 vm 领域，跨领域 deepEqual 会因原型不同而失败
  assert.equal(debug.bound.sessionStatus, true)
  assert.equal(debug.bound.sessionList, true)
  assert.equal(debug.currentSession, 's-current')
  assert.equal(debug.language, 'zh')
  assert.equal(debug.desktopShell, true)
  assert.equal(debug.permission, 'granted')
})

test('test() 绕过规则直接发一条', () => {
  const host = makeHost({ focused: true })
  assert.equal(host.api.test('attention'), 'sent')
  assert.equal(host.notifications().length, 1)
})
