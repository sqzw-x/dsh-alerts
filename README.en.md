# dsh-alerts

English | [中文](README.md)

Focus-aware notifications for DeepSeek Harness: **approvals, questions, plan reviews and finished replies all arrive as one kind of alert**, gated only by window focus and by which conversation the event belongs to.

## Rules

| Where the event happened | When a notification is posted |
| --- | --- |
| The conversation you have open | **Once its window loses focus** — a still-open wait is replayed when you switch away, never twice |
| Any other conversation | **Always**, even with DSH in the foreground |
| Subagent sessions | **Never** |

### Why not "is the page visible"

On macOS, `document.hidden` stays `false` while the window is merely covered by another app — only minimizing (or ⌘H) flips it. A plugin that treats "visible" as "the user is reading" therefore drops approval and question alerts exactly when you are working somewhere else. This plugin uses `document.hasFocus()`: **no keyboard focus means you are away**.

## Install

```sh
dsh plugin --profile desktop add dsh-alerts
# then add "dsh-alerts" to dsh.profile.bundles in the profile's package.json
```

Restart DSH Desktop afterwards; the client bundle is read when the page loads. Disable without uninstalling:

```yaml
- id: dsh-alerts
  disabled: true
```

## Configure

```js
__dshAlerts.configure({ sound: true })
__dshAlerts.debug()
__dshAlerts.test()
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `ignoreSubagent` | `true` | subagent sessions stay silent |
| `language` | `'auto'` | copy language: follows the DSH locale, or pin `'zh'` / `'en'` |
| `sound` | `false` | optional WebAudio chime on top of the notification |

## How it works

Two read-only stores: `uiSession.sessionStatus` (`running`, `pendingInteraction`) and `sessions.list` (title, `origin: 'subagent'`, `retainedBy.mainView` = the conversation on screen). A **wait** is a pending interaction appearing (deduped by request key); a **completion** is that session's `running` bit falling with no wait in its place. Every decision lives in the DOM-free `src/engine.ts`, which is unit-tested directly.

Clicking a notification raises the window (the `dsh://open` deep link on the desktop, `window.focus()` in a browser) and switches to that conversation. Notifications are never auto-closed — the platform style decides how long they stay.

## Development

Node 22+ (toolchain only — the shipped bundle runs in the browser).

```sh
npm install && npm test
```

## License

MIT
