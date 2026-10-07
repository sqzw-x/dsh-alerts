/**
 * Unit tests for the rules. The engine is DOM-free, so these run against plain
 * data and assert the decision table directly:
 *
 *   非当前会话 → 任何时候都弹；当前会话 → 只有失焦才弹；子代理 → 永不弹。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AlertEngine } from '../lib/engine.js'

/** Build an engine over mutable host state. */
function makeEngine(options = {}) {
  const state = {
    focused: options.focused ?? true,
    permission: options.permission ?? 'granted',
    now: 1_000,
    config: {
      enabled: true,
      ignoreSubagent: true,
      language: options.language ?? 'zh',
      sound: false,
      ...(options.config ?? {})
    }
  }
  const engine = new AlertEngine({
    config: () => state.config,
    focused: () => state.focused,
    canNotify: () => state.permission === 'granted',
    language: () => (state.config.language === 'en' ? 'en' : 'zh'),
    now: () => state.now
  })
  return { engine, state }
}

/** A session-list snapshot in the shape `sessions.list` publishes. */
function listSnapshot(rows) {
  return { ids: Object.keys(rows), byId: rows }
}

const row = (title, extra = {}) => ({ displayTitle: title, retainedBy: {}, ...extra })
const current = (title) => row(title, { retainedBy: { mainView: 1 } })

const wait = (key, kind = 'approval', sessionId = 's-other') => ({ key, kind, sessionId })
const status = (entries) => new Map(Object.entries(entries))

/** Seed the engine with one quiet snapshot, the way binding does. */
function seed(engine, sessions = ['s-current', 's-other', 's-sub']) {
  engine.onStatus(status(Object.fromEntries(sessions.map((sid) => [sid, { running: false, pendingInteraction: undefined, completionUnread: false }]))))
}

test('非当前会话：有焦点、无焦点都弹', () => {
  for (const focused of [true, false]) {
    const { engine, state } = makeEngine({ focused })
    engine.onList(listSnapshot({ 's-current': current('当前对话'), 's-other': row('别的对话') }))
    seed(engine)
    const alerts = engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:1') } }))
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].title, 'DSH · 需要你')
    assert.equal(alerts[0].body, '别的对话 · 审批请求')
    assert.equal(alerts[0].tag, 'dsh-alerts:s-other')
    assert.equal(state.focused, focused)
  }
})

test('当前会话：有焦点不弹，失焦后补弹一次', () => {
  const { engine, state } = makeEngine({ focused: true })
  engine.onList(listSnapshot({ 's-current': current('当前对话') }))
  seed(engine)

  const first = engine.onStatus(status({ 's-current': { running: true, pendingInteraction: wait('approval:cur', 'approval', 's-current') } }))
  assert.deepEqual(first, [], '有焦点时不该打扰')

  state.focused = false
  const replayed = engine.replay()
  assert.equal(replayed.length, 1, '失焦时补上这条')
  assert.equal(replayed[0].body, '当前对话 · 审批请求')

  assert.deepEqual(engine.replay(), [], '同一条等待不会重复补弹')
})

test('子代理会话：任何焦点状态都不弹', () => {
  for (const focused of [true, false]) {
    const { engine } = makeEngine({ focused })
    engine.onList(listSnapshot({ 's-current': current('x'), 's-sub': row('子代理步骤', { origin: 'subagent' }) }))
    seed(engine)
    const alerts = engine.onStatus(status({ 's-sub': { running: true, pendingInteraction: wait('approval:sub', 'approval', 's-sub') } }))
    assert.deepEqual(alerts, [])
    assert.deepEqual(engine.replay(), [])
  }
})

test('ignoreSubagent 关掉后子代理照常提醒', () => {
  const { engine } = makeEngine({ config: { ignoreSubagent: false } })
  engine.onList(listSnapshot({ 's-sub': row('子代理步骤', { origin: 'subagent' }) }))
  seed(engine, ['s-sub'])
  const alerts = engine.onStatus(status({ 's-sub': { running: true, pendingInteraction: wait('approval:sub', 'approval', 's-sub') } }))
  assert.equal(alerts.length, 1)
})

test('一个等待只弹一次，回答后再来一个新手会再弹', () => {
  const { engine } = makeEngine({ focused: false })
  engine.onList(listSnapshot({ 's-other': row('别的对话') }))
  seed(engine)
  const pending = { running: true, pendingInteraction: wait('approval:a') }
  assert.equal(engine.onStatus(status({ 's-other': pending })).length, 1)
  assert.equal(engine.onStatus(status({ 's-other': pending })).length, 0, '重复快照不重复提醒')
  assert.equal(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: undefined } })).length, 0)
  assert.equal(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:b') } })).length, 1, '新的等待照常提醒')
})

test('running 掉下来 = 回复完成；停下来等输入不算完成', () => {
  const { engine, state } = makeEngine({ focused: false })
  engine.onList(listSnapshot({ 's-other': row('别的对话') }))
  seed(engine)

  assert.deepEqual(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: undefined } })), [], '开始跑不提醒')
  const done = engine.onStatus(status({ 's-other': { running: false, pendingInteraction: undefined } }))
  assert.equal(done.length, 1)
  assert.equal(done[0].title, 'DSH · 回复完成')
  assert.equal(done[0].body, '别的对话 · 回复已完成')

  state.now += 10_000
  engine.onStatus(status({ 's-other': { running: true, pendingInteraction: undefined } }))
  const waited = engine.onStatus(status({ 's-other': { running: false, pendingInteraction: wait('approval:stop') } }))
  assert.equal(waited.length, 1, '停下来等输入时只有等待那一条')
  assert.equal(waited[0].kind, 'attention')
})

test('同一次完成的两个视图只提醒一次（合并窗口）', () => {
  const { engine, state } = makeEngine({ focused: false })
  engine.onList(listSnapshot({ 's-other': row('别的对话') }))
  seed(engine)
  engine.onStatus(status({ 's-other': { running: true, pendingInteraction: undefined } }))
  assert.equal(engine.onStatus(status({ 's-other': { running: false, pendingInteraction: undefined } })).length, 1)
  // 同一个时间窗内第二条“完成”是同一个事件的另一个视图
  state.now += 50
  engine.onStatus(status({ 's-other': { running: true, pendingInteraction: undefined } }))
  assert.equal(engine.onStatus(status({ 's-other': { running: false, pendingInteraction: undefined } })).length, 0)
})

test('绑定时的既有状态只做基线，不补弹历史', () => {
  const { engine } = makeEngine({ focused: false })
  engine.onList(listSnapshot({ 's-other': row('别的对话') }))
  // 第一条快照里就带着等待：属于既有状态
  const seeded = engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:old') } }))
  assert.deepEqual(seeded, [])
  assert.deepEqual(engine.replay(), [], '基线里的等待也不该被失焦补弹')
  assert.equal(engine.ready, true)
  assert.equal(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:new') } })).length, 1)
})

test('空快照不算基线', () => {
  const { engine } = makeEngine({ focused: false })
  assert.deepEqual(engine.onStatus(status({})), [])
  assert.equal(engine.ready, false)
  engine.onList(listSnapshot({ 's-other': row('别的对话') }))
  // 第一条“有会话”的快照才是基线
  assert.deepEqual(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:first') } })), [])
  assert.equal(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:second') } })).length, 1)
})

test('总开关、通知权限、语言都会生效', () => {
  const off = makeEngine({ config: { enabled: false } })
  off.engine.onList(listSnapshot({ 's-other': row('x') }))
  seed(off.engine)
  assert.deepEqual(off.engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:1') } })), [])

  const denied = makeEngine({ permission: 'denied' })
  denied.engine.onList(listSnapshot({ 's-other': row('x') }))
  seed(denied.engine)
  assert.deepEqual(denied.engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:1') } })), [])

  const english = makeEngine({ language: 'en' })
  english.engine.onList(listSnapshot({ 's-other': row('Other conversation') }))
  seed(english.engine)
  const alerts = english.engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:1') } }))
  assert.equal(alerts[0].title, 'DSH · You are needed')
  assert.equal(alerts[0].body, 'Other conversation · approval request')
})

test('当前会话由 mainView 保留信息推导，离开后不再是“当前”', () => {
  const { engine } = makeEngine({ focused: true })
  engine.onList(listSnapshot({ 's-a': current('A'), 's-b': row('B') }))
  assert.equal(engine.currentSessionId(), 's-a')
  engine.onList(listSnapshot({ 's-a': row('A'), 's-b': row('B') }))
  assert.equal(engine.currentSessionId(), 's-a', '没有新的 mainView 时保持上一次的当前会话')
  engine.onList(listSnapshot({ 's-a': row('A'), 's-b': current('B') }))
  assert.equal(engine.currentSessionId(), 's-b')
})

test('会话消失后释放去重键，标记也随之下线', () => {
  const { engine } = makeEngine({ focused: false })
  engine.onList(listSnapshot({ 's-other': row('x') }))
  seed(engine)
  assert.equal(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:gone') } })).length, 1)
  engine.onStatus(status({}))
  assert.deepEqual(engine.snapshot().trackedSessions, [])
  // 同一个 key 再次出现（极端情况）仍会被当作新等待处理
  assert.equal(engine.onStatus(status({ 's-other': { running: true, pendingInteraction: wait('approval:gone') } })).length, 1)
})

test('forced() 绕过规则，供测试按钮使用', () => {
  const { engine } = makeEngine({ config: { enabled: false } })
  const alert = engine.forced('attention', 's-current')
  assert.equal(alert.kind, 'attention')
  assert.equal(alert.tag, 'dsh-alerts:s-current')
})
