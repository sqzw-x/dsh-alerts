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
__dshAlerts.open('session-id')   // switch conversations by id (defaults to the current one)
```

Two `debug()` fields exist for "I clicked it and nothing happened":

- `navigation` — which service a click will switch conversations through: `uiWorkspace.openSession` / `sessions.open` / `none`.
- `counters.failed` — how many navigation calls threw; each one also logs a `[dsh-alerts] …` warning.

Every posted notification also dispatches a `dsh-alerts:alert` event on `window` (`event.detail` is the alert: `kind` / `sessionId` / `title` / `body` / `tag`), which is where to hang your own reminder — a flashing taskbar, a different sound, a log line.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `ignoreSubagent` | `true` | subagent sessions stay silent |
| `language` | `'auto'` | copy language: follows the DSH locale, or pin `'zh'` / `'en'` |
| `sound` | `false` | optional WebAudio chime on top of the notification |

## How it works

Two read-only stores: `uiSession.sessionStatus` (`running`, `pendingInteraction`) and `sessions.list` (title, `origin: 'subagent'`, `retainedBy.mainView`). They produce the two event kinds behind rule 2: a **wait** is a pending interaction appearing (deduped by request key, so one request alerts once), and a **completion** is that session's `running` bit falling with no wait in its place — stopping to ask you something is a wait, not a completion. Every decision lives in the DOM-free `src/engine.ts`, which is unit-tested directly.

Clicking a notification raises the window (the `dsh://open` deep link on the desktop, `window.focus()` in a browser) and switches to that conversation through the host's `uiWorkspace.openSession` (`sessions.open` on older hosts), bound to its instance before the call; a failure is counted in `counters.failed` and warned about instead of being swallowed the way 0.2.0 swallowed it; the manual ways back (the window regaining focus, switching conversations by hand) end in the same place — the conversation's notification is closed. Notifications you never return to are not auto-closed; the platform style decides how long they stay.

## Known limitations

- **The Web build is unverified**: only DSH Desktop has been tested; browser behaviour (raising the window, the permission flow) has not been checked by anyone.
- Switching conversations needs a host navigation service: `debug().navigation` reading `none` means the host publishes neither `uiWorkspace.openSession` nor `sessions.open`, and a click can only raise the window.
- Works inside DSH Web / DSH Desktop pages only; `dsh-app://` pages cannot register a Service Worker, so notifications carry no buttons (this plugin needs none).
- "The conversation on screen" is derived from `retainedBy.mainView`, which is a **reference count the main view holds** (upstream's own comment: "Local ownership counts, independent of catalog membership and never persisted"), read with the same predicate upstream `isMain()` uses. Where the host does not publish it, every conversation counts as "not current" (and therefore alerts).
- Notification presentation is up to the platform (macOS: System Settings → Notifications → DeepSeek Harness).
- A denied permission means no notifications; `__dshAlerts.debug().permission` reports `denied`.
- **Completions are detected from the `running` edge, not from the SDK's `completionUnread`.** The latter is the sidebar's unread dot: upstream clears it while the main view holds the session and as soon as `running` turns true, so using it as the "reply finished" signal would silently stop background-completion alerts. The trade-off is that a reply finishing before the client ever observes `running === true` (say, across a page reload) does not alert.
- `dsh.compatibility.dshReleases` in `package.json` is **informational only**: nothing in DSH 0.2.0-rc.2 reads it. The real gate is `peerDependencies` on `@deepseek-ai/dsh*` — this package declares `@deepseek-ai/cordis`, whose prefix is not checked, so that peer is inert, exactly as in upstream packages like `dsh-client-ui-session`.

## Development

Node 22.18+ (toolchain only: tsdown requires `^22.18.0 || ^24.11.0 || >=26.0.0` and CI runs 22/24 — the shipped bundle runs in the browser and does not care about the Node version).

```sh
npm install && npm test
```

Four test layers: `test/engine.test.mjs` exercises the rule table, `test/client.test.mjs` loads the built bundle in a vm the way the host does (against a host double shaped like the real one), `test/host.test.mjs` mounts the same bundle as a real cordis fiber on a real `Context`, and `test/manifest.test.mjs` guards the manifest and artifact contract. The rule table is what the tests run against; **the Desktop-only status above is about real-world use, not about what is covered here**.

## License

MIT
