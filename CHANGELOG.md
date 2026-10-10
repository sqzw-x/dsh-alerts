# Changelog

## [0.2.2] — 2026-10-11

一轮针对"该响的没响 / 不该记的记着"的审查修复。没有 API 变化；`__dshAlerts` 表面保持兼容。

### 修复（通知保真度）

- **主视图松手后仍被当成"当前会话"，把该会话的提醒永久压住**。`onList` 里对 `currentId` 只有赋值、没有清空：某个会话一旦持有过 `retainedBy.mainView`，插件就永远认为它在屏幕上；此后当它的**行从列表里消失**（把它关掉、走到非会话页面，或它被释放后不再被列出 —— 单纯切到另一个会话不算，那种情况下它会立刻恢复提醒），它的**完成提醒在窗口有焦点时会被静默丢掉**（`allows()` 走 `!focused()` 分支 —— 用户根本没在看它）。
  - 现在每次列表快照都重新推导，规则与上游 `UiSession.publishMain` 的三段式对齐：① 上一次的当前会话**仍然**持有 `mainView` 引用就保持它；② 否则取**第一个** `mainView > 0` 的行（旧代码是最后一个匹配 —— 多行同时持有引用时会选错）；③ 一个都没有就回到"屏幕上什么都没有"（`null`，所有会话都按"非当前"处理，照常提醒）。
  - 唯一无法完全对齐上游的地方：**持有的那个会话在本快照里没有行**时，上游问的是保留关系存储（`retainInfo`，可以存在没有行的 scope），而插件只看得到列表快照。插件把"没有行"当作"不在屏幕上"，也就是与"视图已经松手"同解 —— 这正是本 PR 要修的语义；反过来保留那个不存在的 id 会把"粘住"放回来。这条分支已写在 `engine.ts` 的注释里。
  - 这修掉的是"该响没响"，不是噪音：只有真正还在屏幕上的那个会话才享受焦点豁免。
- **`delivered` 去重账本无界增长**：等待被回答后只清了 `statuses.pendingKey`，投递过的 key 一直留在 Set 里，只有会话整个消失才释放 —— 长驻页面每回答一次审批/提问就泄漏一个字符串。现在 **key 一旦不再是该会话的当前等待就释放**（被回答，或**被新请求替换** —— 宿主可以在旧请求不曾消失的情况下直接换 key，旧 key 否则会永远留着），账本最多只留"每个会话一个 key"。代价：同一个 key 被撤销后又重新发布（宿主侧的域被卸载再注册）会再提醒一次，旧行为则会把它永久压住。
- **子代理记录不清理**：`subagents` 集合只在行上出现/消失时增删，会话彻底消失后仍留痕。现在在 `onStatus` 的消失循环里清理，但**要等列表快照也不再提它**（`listIds`）—— 只看状态快照就清，会让"行还没到、等待先到"的窗口里子代理开始弹提醒。

### 清理

- **两个不在插件生命周期里的定时器**：抬窗 iframe 的 4s 移除定时器（内部函数里创建，句柄直接丢掉）与权限提示的 3s 定时器，现在都登记进 `disposers`，卸载时清掉；`requestPermission()` 也补了 `disposed` 守卫。
- **`sanitize()` 遇 `null` / 标量会抛**：`readConfig()` 把 `JSON.parse` 的结果直接喂给它，损坏的 `localStorage` 条目（`null` / 数字 / 字符串）会让 `safely` 变成抛错。现在先判类型再读字段。
- **`configure()` 的类型允许 `null`**：它就是给人在控制台里手敲的，`__dshAlerts.configure(null)` 现在安静地什么都不改。
- **定时参数提为具名常量**（`REBIND_INTERVAL_MS` / `PERMISSION_PROMPT_DELAY_MS` / `RAISE_FRAME_LIFETIME_MS`）：它们描述的是"插件怎么绑定"，不是部署开关，所以留在这里而不是塞进 `AlertConfig` 扩大用户面。
- **删掉两个没有任何引用的 devDependencies**：`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`（`src/`、`test/`、构建产物里 0 命中；store 契约是 `src/client.ts` 里的本地结构接口）。
- **`package-lock.json` 版本号补上**：它还停在 0.2.0，现已与 `package.json` 对齐（顺带移除上面两个依赖的锁定项）。
- **`engines.node` 从 `>=18` 改成 `>=22.18`**：DSH 从不读 `engines`，但它是 tsdown 的转译目标，而工具链本身要求 `^22.18.0 || ^24.11.0 || >=26.0.0`（CI 矩阵 22/24）。原来的值描述不了真实门槛。

### 测试

- `test/engine.test.mjs` 新增 6 个用例（主视图释放后恢复提醒、`mainView` 多行时的"保持已有"与"取第一个"两条分支、账本释放（被回答 + 被新请求替换）、子代理清理时机）。把改后的测试文件直接跑在改前的引擎上：**`tests 19 / pass 12 / fail 7`** —— 6 个新用例与被改写的那个断言全部为红，无一"改前也绿"。
- **一处既有断言被改写**：`当前会话由 mainView 保留信息推导…` 里 `assert.equal(engine.currentSessionId(), 's-a', '没有新的 mainView 时保持上一次的当前会话')` —— 这行断言把缺陷本身当成了预期（"粘住"），现在改为 `null` 并换了说明。上 PR 时需要留意这条 diff。
- `test/harness.mjs` 的定时器沙箱补齐并改成可信的句柄语义：原来**只有 `clearInterval`、没有 `clearTimeout`**，于是新加的两个清理 disposer 在测试里会抛 `TypeError` 再被逐个兜住 —— 等于没有任何测试能证明"卸载时清掉"；而且 `setTimeout` 的"句柄"返回的是记录对象，`timeouts` 里存的也是对象，句柄之间不可比较。现在两种定时器共用一个递增 id（与真实宿主一样跨类型唯一），并把 `clearTimeout` 记进 `clearedTimeouts`，既有的卸载用例据此断言权限提示与重绑轮询确实被清掉。全量 `npm test`：47/47 通过（原 41 + 新 6）。

### 文档

- README / README.en 更正：`retainedBy.mainView` 不是字面意义的"屏幕上的那个对话"，而是**主视图持有的引用计数**（上游源码注释：`Local ownership counts, independent of catalog membership and never persisted`）；插件按上游 `isMain()` 的同一判据使用它。开发章节的 Node 门槛与 `engines` 对齐。
- README / README.en 新增说明：`dsh.compatibility.dshReleases` 是**信息性声明**，DSH 0.2.0-rc.2 里没有任何代码读它（真正的兼容闸门是 `peerDependencies` 里的 `@deepseek-ai/dsh*`；本包声明 `@deepseek-ai/cordis`，而这个前缀不被检查，所以那个 peer 是惰性的 —— 与上游 `dsh-client-ui-session` 等包一致）。
- README / README.en 新增"已知取舍"：**完成判定用 `running` 边沿，而不是 SDK 的 `completionUnread`**。`completionUnread` 是侧栏的未读圆点：上游在主视图持有该会话时、以及 `running` 一旦为真时就清它，所以拿它当"回复完成"的信号会让**后台会话的完成提醒静默消失**。本插件的推法对自己的用途是对的；代价是"客户端还没观察到 `running === true` 就完成的回复"不会提醒（例如回复恰好横跨一次页面重载）。

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
