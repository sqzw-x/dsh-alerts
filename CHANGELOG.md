# Changelog

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
