# Changelog

## [0.2.1] — 2026-10-08

### 修复

- **点击通知切不过去会话**（0.1.0 起就有的老 bug）：宿主发布导航能力时给的是**服务实例上的原型方法**（`ctx.uiWorkspace.openSession`），插件却把它当普通函数取出来调用 —— 接收者 `this` 丢了，方法内部在 `this.replaceMain(...)` 上抛 `TypeError`；而点击处理器把异常整个吞掉，于是窗口抬起来了、会话一直没切，控制台也不留痕迹。
  - 导航服务现在**绑到实例**后调用（`uiWorkspace.openSession` 与旧的 `sessions.open` 都走这条路）。
  - 导航失败**不再静默**：计入 `debug().counters.failed` 并打一条 `console.warn`。
  - `debug()` 新增 `navigation` 字段，直接告诉你点击会走哪个服务：`uiWorkspace.openSession` / `sessions.open` / `none`。
  - 新增 `__dshAlerts.open(sessionId?)`：按 id 切会话（缺省切当前会话），用来单独验点击路径。
  - `dsh.client.inject` 补上 `@deepseek-ai/dsh-client-ui-workspace` —— 导航服务就是它提供的。

### 测试

- 测试宿主改成**照着真实宿主的样子**造：`sessions` 没有 `open()`（`ISessions` 本来就没有），`uiWorkspace.openSession` 是带 `this` 的原型方法。之前那个假宿主用的是箭头函数，所以这组用例在 bug 面前全绿。
- 新增 `test/host.test.mjs`：把插件作为**真正的 cordis fiber**（真的 `inject`、真的 `Service` 实例）挂在真 `Context` 上跑，确认没注入的服务也能 `get()` 到、点击时接收者不丢。
- 上面两组用例在旧代码上全红，改完才绿。

### 清理

- 删掉 `debug().counters.withheld`：这个计数器从 0.1.0 起就是个摆设，声明了却从来没有累加过，永远显示 0 —— 一个会说谎的字段比没有更误导人。想看"哪些等待没送出去"，用 `debug().openWaits` 与 `deliveredKeys` 的差集，那本来就是逐条的、信息更全。
- 删掉 `client.ts` 里一个没用到的局部绑定。

## [0.2.0] — 2026-10-08

### 行为

- **回到会话就收掉通知**（规则 3 补齐）：之前只有点通知才会关，现在手动回去也算 —— 窗口重新获得焦点时收掉当前会话的通知，手动切到某个会话时收掉那个会话的通知。窗口失焦时切会话不会顺手消掉（人可能还在别的应用里）。
- `debug().counters` 增加 `dismissed`，记录收掉的条数。

### 文档

- README 把机制收敛成三条规则（看会话分 / 看事件分 / 回到会话就收掉），并写明**只在 DSH Desktop 上实测过，Web 版未知**。

## [0.1.0] — 2026-10-07

首个版本。

### 规则

- **统一提醒**：审批、方案确认、提问（`ask_user_question`）与回复完成走同一条通道，只有文案不同。
- **当前对话只在失焦时提醒**：被别的应用盖住但没最小化也算失焦（`document.hasFocus()`），排队中的提醒在窗口失焦或页面隐藏时补发一次；等待被回答后不再补发。
- **其它对话任何时候都提醒**，包括 DSH 在前台。
- **子代理会话从不提醒**（`ignoreSubagent`，可关）。

### 行为

- 按请求 key 去重：一个等待一条通知；同一会话用同一个 tag，新事件替换旧通知而不是堆叠。
- 点击通知：唤起窗口（桌面端 `dsh://open` 深链）并切到对应会话。
- 不自动关闭通知：展示时长交给系统样式（macOS「持续/提醒」会一直留着，直到你处理）。
- 首次绑定只建立基线，不补发历史提醒。
- 运行时 API：`window.__dshAlerts.{debug,configure,test}`。

### 工程

- TypeScript + tsdown：产物 `lib/{index,client,engine}.js`，客户端 bundle 与官方 `ui-*` bundle 同形（`window.__ModuleLoader__.load` 懒执行工厂）。
- 三层测试：规则单测（`lib/engine.js`）、产物装载与接线（vm 加载 `lib/client.js`）、清单与产物契约。
- GitHub Actions 在 Node 20 / 22 / 24 上跑类型检查与测试。
