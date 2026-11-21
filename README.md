# Desktop toast notifications for DeepSeek Harness

Windows notification-center toasts for DeepSeek Harness: one when a turn finishes, one when the agent waits for your choice, and one when it waits for a tool approval. The toast is attributed to **DeepSeek Harness** (or Windows PowerShell when that identity is not registered), carries the DS logo, and keeps its text, image, sound, and per-event switches in the plugin's Config.

```
任务已完成！
DeepSeek Harness
```

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
dsh plugin --profile <profile> add github:owner/dsh-notify-toast
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
| `debugLog` | `false` | append each toast to `%TEMP%\dsh-notify-toast.log` |

## Preview without waiting for a turn

```powershell
powershell.exe -NoProfile -File "<plugin dir>\powershell\toast.ps1" -Title "任务已完成！" -Body "DeepSeek Harness"
```

Options: `-Icon <absolute path>`, `-AppId <AUMID>`, `-Sound silent`, `-Duration long`.

## Limitations

- Windows only. The user must leave notifications enabled for the app and must not be in Focus Assist / Do Not Disturb.
- The toast is attributed to DeepSeek Harness only when the Desktop installer's Start Menu shortcut (`com.deepseek.dsh`) exists; otherwise the plugin falls back to the always-registered Windows PowerShell identity so the toast still appears.
- Clicking a toast does not focus the DSH window (no COM activator is registered).
- Each toast starts one Windows PowerShell process (~0.3–0.6 s). Notifications are low-frequency, so this does not affect a turn.

## License

MIT
