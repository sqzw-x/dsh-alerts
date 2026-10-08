# dsh-alerts

[![CI](https://github.com/sqzw-x/dsh-alerts/actions/workflows/ci.yml/badge.svg)](https://github.com/sqzw-x/dsh-alerts/actions/workflows/ci.yml)

[English](README.en.md) | 中文

给 DeepSeek Harness 的通知插件：**审批、提问、方案确认、回复完成，统一当成一种提醒推送**。规则只有三条。

## 规则

1. **看会话分**：当前会话只在窗口失去焦点时弹；其它会话一律弹，DSH 就在前台也弹。
2. **看事件分**：轮次结束（回复完成）和等你操作（审批 / 方案确认 / 提问）都会弹。
3. **回到会话就收掉**：你聚焦到某个会话时，它的通知自动消失 —— 点通知进去、切回窗口、手动切到该会话都算。

子代理会话是个例外：它既不是"当前会话"也不提醒，整个不参与（`ignoreSubagent`，可以关）。

### 为什么不用「页面可见」判断

macOS 上窗口被别的应用盖住时，`document.hidden` 仍然是 `false` —— 只有最小化 / ⌘H 才会变成 `true`。按「页面可见就不提醒」实现的插件，会把"DSH 被 Edge/QQ 盖住"误判成"用户正看着它"，于是你人在别的应用里时，提问和审批的通知被直接丢掉。

这个插件用的是 `document.hasFocus()`：**窗口没有键盘焦点就算你不在**。当前会话因此只在你真正盯着它时保持安静；反过来，收通知也要手里有焦点才算数 —— 失焦时切会话不会顺手消掉通知，人可能还在别的应用里。

## 测试状态

**只在 DSH Desktop 上实测过。Web 版能不能正常工作未知**（代码里按浏览器语义写了 `window.focus()` 之类的分支，但没人验证过）。

## 安装

### 插件管理器

在「设置 → 插件」里安装本包的目录（或已发布的 `dsh-alerts`），启用后重启 DSH Desktop。

### 命令行

```sh
# 1) 装进 profile（desktop 换成你要用的 profile 名）
dsh plugin --profile desktop add dsh-alerts

# 2) 让 profile 组合带上这个 bundle：在
#    ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 里加上 "dsh-alerts"
```

从本地目录安装（开发时）：

```sh
dsh plugin --profile desktop add file:/absolute/path/to/dsh-alerts
```

装完**重启 DSH Desktop**：客户端 bundle 在页面加载时读取。停用而不卸载：在 profile 的 `cordis.patch.yml` 里写

```yaml
- id: dsh-alerts
  disabled: true
```

## 配置

默认值就能用。想改的话，在页面的控制台里：

```js
__dshAlerts.configure({ sound: true })   // 打开提示音
__dshAlerts.configure({ enabled: false }) // 暂时全关
__dshAlerts.debug()                       // 当前会话、未送达的等待、计数器、权限、焦点
__dshAlerts.test()                        // 绕过规则立刻发一条，验证通道
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后仍然跟踪状态，只是不发通知 |
| `ignoreSubagent` | `true` | 子代理会话不提醒 |
| `language` | `'auto'` | 文案语言：跟随 DSH 界面语言，也可固定 `'zh'` / `'en'` |
| `sound` | `false` | 通知之外再响一声（WebAudio，需要页面有过交互） |

配置存在 `localStorage` 的 `dshAlerts.config`。

## 它怎么工作

两个只读数据源，都是宿主已经发布好的 store：

- `uiSession.sessionStatus` — `Map<sessionId, { running, pendingInteraction, completionUnread }>`
- `sessions.list` — 会话行（标题、`origin: 'subagent'`、`retainedBy.mainView` 即"屏幕上的那个对话"）

由它们派生出两类事件，对应上面第 2 条规则：

- **等你操作**：某个会话出现了 `pendingInteraction`（审批 / 方案确认 / 提问）。按请求 `key` 去重，同一个请求只提醒一次。
- **回复完成**：某个会话的 `running` 从 `true` 落到 `false`，且没有紧接着的等待（停下来等你输入算"等你操作"，不算"完成"）。

规则判定集中在 `src/engine.ts` 的 `allows()` 里，全部是纯逻辑、不碰 DOM，因此可以脱离浏览器单测。点击通知会唤起窗口（桌面端走 `dsh://open` 深链，浏览器端 `window.focus()`）并切到对应的会话；手动回去的路子（窗口重新获得焦点、手动切会话）和它走同一个收尾：关掉该会话的通知。没回去过的通知不会自己消失，展示时长仍由系统样式决定。

## 已知限制

- **Web 版未验证**：只在 DSH Desktop 上实测过，浏览器里的行为（抬窗、通知权限流程）没人验证。
- 只在 DSH Web / DSH Desktop 的页面里工作；`dsh-app://` 页面注册不了 Service Worker，所以没有通知上的按钮（本插件也不需要）。
- "屏幕上的那个对话"由 `retainedBy.mainView` 推导；宿主没有这一信息时，所有会话都按"非当前"处理（也就是都会提醒）。
- 通知的展示样式由系统决定（macOS：系统设置 → 通知 → DeepSeek Harness）。
- 权限被拒绝时不发通知，`__dshAlerts.debug().permission` 会显示 `denied`。

## 开发

需要 Node 22+（构建工具链的要求；产物本身只跑在浏览器里）。

```sh
npm install
npm run build      # tsdown → lib/{index,client,engine}.js
npm run typecheck  # tsc --noEmit
npm test           # 构建 + node --test
```

`lib/client.js` 是浏览器产物，包在 `window.__ModuleLoader__.load({ id, factory })` 里（与官方 `ui-*` bundle 同形），包装由 `tsdown.config.ts` 的 banner/footer 生成。测试分三层：`test/engine.test.mjs` 打规则表，`test/client.test.mjs` 把构建产物放进 vm 里按宿主的方式加载，`test/manifest.test.mjs` 盯清单与产物契约。上面说的"只在 Desktop 实测过"指的是真实使用，不是这些测试覆盖了什么。

## License

MIT
