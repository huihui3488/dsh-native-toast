# 桌面通知弹窗

任务结束时不用一直盯着窗口：DeepSeek Harness 会在 Windows 桌面右下角弹出一条系统原生通知（与「设置 → 通知」里其他应用的通知同属通知中心），并保留在通知中心历史里。

## 什么时候弹

| 触发时机 | 来源事件 | 默认标题 |
| --- | --- | --- |
| 一轮任务结束（模型不再欠响应、也没有待执行工具） | `agent/turn-stopping` | 任务已完成！ |
| 代理需要你做出选择 | `user-questions/request` | 需要你的选择 |
| 代理需要你批准工具执行 | `approval/request` | 需要你的确认 |

- 默认只通知你亲自驱动的会话；子代理、工作流子会话结束时不打扰（`includeSubagents` 可打开）。
- 用户主动中断的那一轮不会显示「任务已完成！」。
- 连续多条通知按 `minGapMs` 排队，相同内容在 `dedupeMs` 内只弹一次。

## 外观

通知使用 DeepSeek Harness 已安装的 `com.deepseek.dsh` 通知身份，因此系统里显示的应用名是 **DeepSeek Harness**，左侧图标是内置的 DS 徽标（`assets/dsh-logo.png`，也可换成自己的图片）。通知内容为两行：第一行是标题，第二行是副标题。

## 点击通知

- **窗口已经在屏幕上（可见、未最小化）**：完全不碰窗口——不移动、不改大小、不抢焦点，只把会话滚到对应位置。
- **当前打开的是别的会话**：先自动切到通知所属的会话，再滚动过去。
- **最小化或隐藏**：恢复并聚焦窗口，保持原来的最大化/普通状态；应用没在运行时会尝试启动它。
- **完成任务的通知**：会话滚动到最底部（已经在底部也会再滚一次）。
- **选择 / 批准的通知**：滚动到那条提问并把第一个选项聚焦，按回车即可作答；找不到提问文本时退回滚到底部。

实现方式：插件启用时在 `HKCU\Software\Classes` 注册 `dsh-native-toast:` 协议（禁用插件时移除），点击通知由 `powershell/activate.ps1` 处理并记录到 Host 的本地路由，插件的 Client 半边（`client.js`）轮询该路由完成滚动。因此点击需要网页界面正在打开；超过 30 秒的点击会被忽略。这两条本地路由只接受本机回环地址。

## 配置

安装后进入 **插件 → 桌面通知弹窗**，行上的「配置」按钮会打开表单；也可以直接改 `cordis.patch.yml` 中 `id: desktop-toast` 这一行的 `config`。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `onComplete` | `true` | 任务完成时通知 |
| `completeTitle` | `任务已完成！` | 完成通知标题 |
| `completeBody` | `DeepSeek Harness` | 完成通知副标题 |
| `onQuestion` | `true` | 需要选择时通知 |
| `questionTitle` | `需要你的选择` | 选择通知标题 |
| `onApproval` | `true` | 需要批准时通知 |
| `approvalTitle` | `需要你的确认` | 批准通知标题 |
| `includeSubagents` | `false` | 子代理结束也通知 |
| `appId` | `com.deepseek.dsh` | 通知归属的 AppUserModelID |
| `showLogo` | `true` | 显示徽标 |
| `logoPath` | 空 | 自定义图片绝对路径（png/jpg） |
| `playSound` | `true` | 播放系统提示音 |
| `dedupeMs` | `1500` | 相同内容去重窗口 |
| `minGapMs` | `900` | 两条通知最小间隔 |
| `powershellPath` | 空 | 自定义 powershell.exe |
| `debugLog` | `false` | 把通知记录写入 `%TEMP%\dsh-native-toast.log` |
| `clickToFocus` | `true` | 点击通知时聚焦窗口并滚动到任务完成处或待回答的提问 |

## 手动预览

改完文字或图片后不必等下一轮任务，直接跑一次即可看到效果：

```powershell
powershell.exe -NoProfile -File "<插件目录>\powershell\toast.ps1" -Title "任务已完成！" -Body "DeepSeek Harness"
```

可选参数：`-Icon <图片绝对路径>`、`-AppId <AUMID>`、`-Sound silent`、`-Duration long`。

## 限制

- 仅支持 Windows，且需要系统「通知」对该应用开启、未处于「专注助手/勿扰」屏蔽状态。
- 通知归属默认复用已安装 DeepSeek Harness 的开始菜单快捷方式（`com.deepseek.dsh`）；检测不到该快捷方式时（例如只用 `dsh web` 的机器）会自动退回 Windows PowerShell 的通知身份，保证通知仍能弹出，只是应用名显示为 Windows PowerShell。也可以手动把 `appId` 设为 `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`。
- 每次通知会启动一次 Windows PowerShell（约 0.3–0.6 秒），通过随包的 `powershell/hidden.vbs` 交给 `wscript.exe` 隐藏启动，不会闪出命令行窗口。属于低频事件，不影响对话速度。
- 点击通知需要网页界面正在打开、且由桌面壳托管窗口；纯 CLI 会话没有可聚焦的窗口。点击记录 30 秒后过期。
