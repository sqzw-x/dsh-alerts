# dsh-alerts

[![CI](https://github.com/sqzw-x/dsh-alerts/actions/workflows/ci.yml/badge.svg)](https://github.com/sqzw-x/dsh-alerts/actions/workflows/ci.yml)

English | [中文](README.md)

Focus-aware notifications for DeepSeek Harness: **approvals, questions, plan reviews and finished replies all arrive as one kind of alert**. Three rules, no more.

## Rules

1. **By conversation**: the conversation on screen only alerts once its window loses focus; every other conversation alerts always, even with DSH in the foreground.
2. **By event**: a finished turn and a request waiting on you (approval / plan review / question) both alert.
3. **Coming back clears it**: focusing a conversation makes its notification go away — clicking the notification, switching back to the window, or picking the conversation by hand.

Subagent sessions are the one exception: they are never "the conversation on screen" and never alert (`ignoreSubagent`, can be turned off).

### Why not "is the page visible"

On macOS, `document.hidden` stays `false` while the window is merely covered by another app — only minimizing (or ⌘H) flips it. A plugin that treats "visible" as "the user is reading" therefore drops approval and question alerts exactly when you are working somewhere else. This plugin uses `document.hasFocus()`: **no keyboard focus means you are away**. The on-screen conversation therefore stays quiet only while you are actually looking at it — and symmetrically, clearing an alert also requires keyboard focus: switching conversations while the window is blurred leaves notifications alone, since you may still be in another app.

## Testing status

**Only DSH Desktop has been exercised in practice. Whether the Web build works is unknown** — the code has browser-semantics branches (`window.focus()` and friends), but nobody has verified them.

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

Two read-only stores: `uiSession.sessionStatus` (`running`, `pendingInteraction`) and `sessions.list` (title, `origin: 'subagent'`, `retainedBy.mainView` = the conversation on screen). They produce the two event kinds behind rule 2: a **wait** is a pending interaction appearing (deduped by request key, so one request alerts once), and a **completion** is that session's `running` bit falling with no wait in its place — stopping to ask you something is a wait, not a completion. Every decision lives in the DOM-free `src/engine.ts`, which is unit-tested directly.

Clicking a notification raises the window (the `dsh://open` deep link on the desktop, `window.focus()` in a browser) and switches to that conversation; the manual ways back (the window regaining focus, switching conversations by hand) end in the same place — the conversation's notification is closed. Notifications you never return to are not auto-closed; the platform style decides how long they stay.

## Known limitations

- **The Web build is unverified**: only DSH Desktop has been tested; browser behaviour (raising the window, the permission flow) has not been checked by anyone.
- Works inside DSH Web / DSH Desktop pages only; `dsh-app://` pages cannot register a Service Worker, so notifications carry no buttons (this plugin needs none).
- "The conversation on screen" is derived from `retainedBy.mainView`; where the host does not publish it, every conversation counts as "not current" (and therefore alerts).
- Notification presentation is up to the platform (macOS: System Settings → Notifications → DeepSeek Harness).
- A denied permission means no notifications; `__dshAlerts.debug().permission` reports `denied`.

## Development

Node 22+ (toolchain only — the shipped bundle runs in the browser).

```sh
npm install && npm test
```

The three test layers: `test/engine.test.mjs` exercises the rule table, `test/client.test.mjs` loads the built bundle in a vm the way the host does, and `test/manifest.test.mjs` guards the manifest and artifact contract. The rule table is what the tests run against; **the Desktop-only status above is about real-world use, not about what is covered here**.

## License

MIT
