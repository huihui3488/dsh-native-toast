# Desktop toast notifications for DeepSeek Harness

Windows notification-center toasts for DeepSeek Harness: one when a turn finishes, one when the agent waits for your choice, and one when it waits for a tool approval. Clicking a toast brings the app forward and takes you to the right place. The toast is attributed to **DeepSeek Harness** (or Windows PowerShell when that identity is not registered), carries the DS logo, and keeps its text, image, sound, and per-event switches in the plugin's Config.

```
任务已完成！
DeepSeek Harness
```

## Click behaviour

- **Window already on screen** (visible, not minimized): it is never moved or resized. If another window covers part of it, the app is brought to the front; when it is already in front, nothing changes.
- **Another conversation is open**: the app switches to the Session the toast belongs to, then scrolls there.
- **Minimized or hidden**: the window is restored and focused, keeping its maximized/normal state; if the app is not running, it is started.
- **Finished turn**: the conversation scrolls so the start of the latest assistant output sits 24 px below the top of the transcript.
- **Choice or approval**: the conversation is positioned the same way, and the pending question's first option is focused, so the answer is one keystroke away. If the question text cannot be found, only the scroll happens.

This works through a per-user URL protocol, `dsh-native-toast:`, registered under `HKCU\Software\Classes` while the plugin is enabled and removed when it is disabled. The protocol handler is `powershell/activate.ps1`; it writes the click to `%TEMP%\dsh-native-toast-click.json`, the Host watches that file, and the plugin's Client half (`client.js`) polls the Host's local route and performs the scroll. No listening port is involved, so a restarted Host on a new port keeps working. Clicking needs the Web GUI page to be open; an action older than 30 seconds is ignored.

The plugin's four local routes (`/api/dsh-native-toast/{pending,report,click,status}`) answer only the browser the Web GUI is already logged in as: each one applies `ctx.connection.requestRejection` to the incoming request, so a request without Connection's browser credential or from another Origin gets the same `401`/`403` Connection itself would return. A web page open in the same browser can therefore not read the pending click or steer the scroll target.

## What it does

| Moment | Event | Default title |
| --- | --- | --- |
| A turn closes with nothing left to do | `agent/turn-stopping` | 任务已完成！ |
| The agent asks you to choose | `user-questions/request` | 需要你的选择 |
| The agent asks you to approve a tool call | `approval/request` | 需要你的确认 |

- The two decision events are waterfalls. This plugin registers with `prepend`, notifies, and calls `next()`, so the Web GUI answerer still owns the decision.
- Subagent and workflow sessions stay quiet by default (`includeSubagents` turns them on).
- A turn the user aborted does not report "completed".
- Identical content is deduplicated for `dedupeMs`; consecutive toasts are spaced by `minGapMs`.
- The Desktop Host runs in its own process without Electron's `Notification`, so a bundled PowerShell (WinRT) helper renders the toast. There are no npm dependencies.

## Install

```sh
dsh plugin --profile <profile> add github:huihui3488/dsh-native-toast
```

Or install the package directory from **Plugins → Add plugin** in the Desktop app. Windows only: on other platforms the plugin activates and does nothing.

## Configuration

Every row field is editable from **Plugins → Desktop toast notifications → Configure** (schema-backed), or from the profile patch:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `onComplete` | `true` | notify when a turn ends |
| `completeTitle` / `completeBody` | `任务已完成！` / `DeepSeek Harness` | completion toast text |
| `onQuestion` / `questionTitle` | `true` / `需要你的选择` | choice notifications |
| `onApproval` / `approvalTitle` | `true` / `需要你的确认` | approval notifications |
| `includeSubagents` | `false` | also notify for subagent sessions |
| `appId` | `com.deepseek.dsh` | AppUserModelID the toast belongs to |
| `showLogo` / `logoPath` | `true` / empty | show the DS logo or a custom image |
| `playSound` | `true` | play the system notification sound |
| `dedupeMs` / `minGapMs` | `1500` / `900` | duplicate window, minimum gap |
| `powershellPath` | empty | custom `powershell.exe` |
| `debugLog` | `false` | append each toast to `%TEMP%\dsh-native-toast.log` |
| `clickToFocus` | `true` | bring the app forward and scroll on click |

## Preview without waiting for a turn

```powershell
powershell.exe -NoProfile -File "<plugin dir>\powershell\toast.ps1" -Title "任务已完成！" -Body "DeepSeek Harness"
```

Options: `-Icon <absolute path>`, `-AppId <AUMID>`, `-Sound silent`, `-Duration long`.

## Limitations

- Windows only. The user must leave notifications enabled for the app and must not be in Focus Assist / Do Not Disturb.
- The toast is attributed to DeepSeek Harness only when the Desktop installer's Start Menu shortcut (`com.deepseek.dsh`) exists; otherwise the plugin falls back to the always-registered Windows PowerShell identity so the toast still appears.
- Clicking a toast needs the Web GUI page to be open and needs the Desktop shell to own the window; a headline-only CLI Session has no window to focus. The click action expires after 30 seconds.
- An always-on-top window from another app can keep covering the app even after it is raised.
- Each toast starts one Windows PowerShell process (~0.3–0.6 s), launched through the bundled `powershell/hidden.vbs` under `wscript.exe` so no console window appears. Notifications are low-frequency, so this does not affect a turn.

## License

MIT


