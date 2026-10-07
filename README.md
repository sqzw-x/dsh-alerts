# dsh-alerts

[English](README.en.md) | 中文

给 DeepSeek Harness 的通知插件：**审批、提问、方案确认、回复完成，统一当成一种提醒推送**，只按「窗口有没有焦点」和「事件属于哪个会话」决定弹不弹。

## 规则

| 事件所在会话 | 什么时候弹系统通知 |
| --- | --- |
| 你正在看的那个对话 | **窗口失去焦点时弹一次**（还在等的话，切走就补弹；不会重复轰炸） |
| 其它任何对话 | **任何时候都弹**，包括 DSH 就在前台 |
| 子代理会话 | **从不弹** |

### 为什么不用「页面可见」判断

macOS 上窗口被别的应用盖住时，`document.hidden` 仍然是 `false` —— 只有最小化 / ⌘H 才会变成 `true`。按「页面可见就不提醒」实现的插件，会把"DSH 被 Edge/QQ 盖住"误判成"用户正看着它"，于是你人在别的应用里时，提问和审批的通知被直接丢掉。

这个插件用的是 `document.hasFocus()`：**窗口没有键盘焦点就算你不在**。当前对话因此只在你真正盯着它时保持安静。

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

由它们派生出两类事件：

- **等待**：某个会话出现了 `pendingInteraction`（审批 / 方案确认 / 提问）。按 `key` 去重，一个请求只提醒一次。
- **完成**：某个会话的 `running` 从 `true` 落到 `false`，且没有紧接着的等待（停下来等你输入不算"完成"）。

规则判定集中在 `src/engine.ts` 的 `allows()` 里，全部是纯逻辑、不碰 DOM，因此可以脱离浏览器单测。点击通知会唤起窗口（桌面端走 `dsh://open` 深链，浏览器端 `window.focus()`）并切到对应的会话；通知不再自动关闭，由系统样式和你的操作决定它什么时候消失。

## 已知限制

- 只在 DSH Web / DSH Desktop 的页面里工作；`dsh-app://` 页面注册不了 Service Worker，所以没有通知上的按钮（本插件也不需要）。
- "屏幕上的那个对话"由 `retainedBy.mainView` 推导；宿主没有这一信息时，所有会话都按"非当前"处理（也就是都会提醒）。
- 通知的展示样式由系统决定（macOS：系统设置 → 通知 → DeepSeek Harness）。
- 权限被拒绝时不发通知，`__dshAlerts.debug().permission` 会显示 `denied`。

## 开发

```sh
npm install
npm run build      # tsdown → lib/{index,client,engine}.js
npm run typecheck  # tsc --noEmit
npm test           # 构建 + node --test
```

`lib/client.js` 是浏览器产物，包在 `window.__ModuleLoader__.load({ id, factory })` 里（与官方 `ui-*` bundle 同形），包装由 `tsdown.config.ts` 的 banner/footer 生成。测试分三层：`test/engine.test.mjs` 打规则表，`test/client.test.mjs` 把构建产物放进 vm 里按宿主的方式加载，`test/manifest.test.mjs` 盯清单与产物契约。

## License

MIT
