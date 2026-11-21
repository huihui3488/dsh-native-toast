/**
 * Desktop toast notifications for DeepSeek Harness (Host half).
 *
 * Listens for the two moments a user typically looks away from the window:
 *  - `agent/turn-stopping` — the turn is about to close, i.e. the task finished.
 *  - `user-questions/request` / `approval/request` — the agent needs a decision.
 *
 * Rendering is delegated to the Windows notification center through a small
 * PowerShell (WinRT) helper, because the Desktop Host runs in its own child
 * process without the Electron `Notification` API. Every user-visible string,
 * the logo, the sound, and the AppUserModelID are Config fields, so the toast
 * can be re-styled later without touching this file.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOGO = join(HERE, 'assets', 'dsh-logo.png')
const TOAST_SCRIPT = join(HERE, 'powershell', 'toast.ps1')
const WINDOWS_POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const POWERSHELL_FALLBACK_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
const DEFAULT_DESKTOP_APP_ID = 'com.deepseek.dsh'
const MAX_TEXT = 220
const PROTOCOL_SCHEME = 'dsh-native-toast'
const CLICK_PATH = '/api/dsh-native-toast/click'
const PENDING_PATH = '/api/dsh-native-toast/pending'
const STATUS_PATH = '/api/dsh-native-toast/status'
const CLICK_TTL_MS = 30_000
const ACTIVATE_SCRIPT = join(HERE, 'powershell', 'activate.ps1')
const PROTOCOL_SCRIPT = join(HERE, 'powershell', 'protocol.ps1')
const STATE_FILE = join(tmpdir(), 'dsh-native-toast-state.json')

export const name = 'desktop-toast'

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关：关闭后完全不弹通知。'),
  onComplete: Schema.boolean().default(true).description('一轮任务结束时弹出通知。'),
  completeTitle: Schema.string().default('任务已完成！').description('任务完成通知的标题。'),
  completeBody: Schema.string().default('DeepSeek Harness').description('任务完成通知的副标题。'),
  onQuestion: Schema.boolean().default(true).description('需要你做出选择时弹出通知。'),
  questionTitle: Schema.string().default('需要你的选择').description('选择通知的标题。'),
  onApproval: Schema.boolean().default(true).description('需要你批准工具执行时弹出通知。'),
  approvalTitle: Schema.string().default('需要你的确认').description('批准通知的标题。'),
  includeSubagents: Schema.boolean().default(false).description('子代理 / 工作流子会话结束时也弹通知。'),
  appId: Schema.string().default('com.deepseek.dsh').description('通知归属的 AppUserModelID，默认复用已安装的 DeepSeek Harness。'),
  showLogo: Schema.boolean().default(true).description('在通知上显示 DS 徽标。'),
  logoPath: Schema.string().default('').description('自定义通知图片的绝对路径，留空使用内置徽标。'),
  playSound: Schema.boolean().default(true).description('弹出通知时播放系统提示音。'),
  dedupeMs: Schema.number().default(1500).description('相同内容在此毫秒内只弹一次。'),
  minGapMs: Schema.number().default(900).description('两条通知之间的最小间隔（毫秒）。'),
  powershellPath: Schema.string().default('').description('自定义 powershell.exe 路径，留空自动使用系统 Windows PowerShell。'),
  debugLog: Schema.boolean().default(false).description('把每次通知写入临时目录日志，便于排查。'),
  clickToFocus: Schema.boolean().default(true).description('点击通知时聚焦 DSH 窗口，并滚动到会话底部或对应提问。'),
})

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const logo = text(raw.logoPath, '')
  return {
    enabled: raw.enabled !== false,
    onComplete: raw.onComplete !== false,
    completeTitle: text(raw.completeTitle, '任务已完成！'),
    completeBody: text(raw.completeBody, 'DeepSeek Harness'),
    onQuestion: raw.onQuestion !== false,
    questionTitle: text(raw.questionTitle, '需要你的选择'),
    onApproval: raw.onApproval !== false,
    approvalTitle: text(raw.approvalTitle, '需要你的确认'),
    includeSubagents: raw.includeSubagents === true,
    appId: text(raw.appId, 'com.deepseek.dsh'),
    showLogo: raw.showLogo !== false,
    logoPath: logo,
    playSound: raw.playSound !== false,
    dedupeMs: clampNumber(raw.dedupeMs, 1500, 0, 60000),
    minGapMs: clampNumber(raw.minGapMs, 900, 0, 60000),
    powershellPath: text(raw.powershellPath, ''),
    debugLog: raw.debugLog === true,
    clickToFocus: raw.clickToFocus !== false,
  }
}

function truncate(value, max = MAX_TEXT) {
  const input = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (input.length <= max) return input
  return input.slice(0, max - 1) + '…'
}

/** The Desktop installer's Start Menu shortcut is what registers `com.deepseek.dsh`. */
function desktopAppIdRegistered() {
  const roots = [
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ]
  return roots.some((root) => root !== '' && existsSync(join(root, 'DeepSeek Harness.lnk')))
}

function localized(display, fallback) {
  if (!display || typeof display !== 'object') return fallback
  const zh = typeof display.zh === 'string' ? display.zh.trim() : ''
  if (zh !== '') return zh
  const en = typeof display.en === 'string' ? display.en.trim() : ''
  return en !== '' ? en : fallback
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return
  if (process.platform !== 'win32') return

  // An unregistered AppUserModelID is accepted by WinRT but its toast never
  // renders, so the installed Desktop identity only applies when its Start
  // Menu shortcut is present; otherwise the always-registered PowerShell
  // identity keeps notifications visible.
  const appId = config.appId !== DEFAULT_DESKTOP_APP_ID || desktopAppIdRegistered()
    ? config.appId
    : POWERSHELL_FALLBACK_APP_ID

  const pending = []
  const recent = new Map()
  const logPath = join(tmpdir(), 'dsh-native-toast.log')
  let running = false
  let lastShownAt = 0
  let drainTimer
  let disposed = false

  /** Append one diagnostic line when `debugLog` is on; never throws. */
  function log(line) {
    if (!config.debugLog) return
    try {
      appendFileSync(logPath, new Date().toISOString() + ' ' + line + '\r\n', 'utf8')
    } catch {
      /* diagnostics must never break the turn */
    }
  }

  /*
   * Toast click bridge: the toast's protocol activation runs
   * powershell/activate.ps1, which brings the Desktop window forward and
   * POSTs the click here. The Client half polls PENDING_PATH and scrolls the
   * conversation or reveals the pending question.
   */
  let pendingAction
  let lastPollAt = 0
  let webServer
  let origin = ''
  try {
    webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer && typeof webServer.getOrigin === 'function') origin = webServer.getOrigin()
  } catch {
    webServer = undefined
    origin = ''
  }

  function isLoopback(req) {
    const address = req && req.socket ? req.socket.remoteAddress : undefined
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  function sendJson(res, status, payload) {
    if (res.headersSent) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /** GET PENDING_PATH — the Client half asks for a click newer than `since`. */
  function onPending(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { action: null })
    if ((req.method ?? '').toUpperCase() !== 'GET') return sendJson(res, 405, { action: null })
    lastPollAt = Date.now()
    let since = 0
    try {
      since = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('since') ?? '0') || 0
    } catch {
      since = 0
    }
    const action = pendingAction
    if (action === undefined || action.at <= since || Date.now() - action.at > CLICK_TTL_MS) {
      return sendJson(res, 200, { action: null })
    }
    return sendJson(res, 200, { action })
  }

  /** GET STATUS_PATH — local diagnostics for the click bridge. */
  function onStatus(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false })
    if ((req.method ?? '').toUpperCase() !== 'GET') return sendJson(res, 405, { ok: false })
    return sendJson(res, 200, { origin, lastPollAt, pending: pendingAction ?? null })
  }

  /** POST CLICK_PATH — activate.ps1 records what the user clicked. */
  function onClick(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false })
    if ((req.method ?? '').toUpperCase() !== 'POST') return sendJson(res, 405, { ok: false })
    let kind = 'complete'
    let text = ''
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      kind = (url.searchParams.get('kind') ?? 'complete').slice(0, 32)
      text = (url.searchParams.get('text') ?? '').slice(0, MAX_TEXT)
    } catch {
      /* malformed query falls back to a plain completion click */
    }
    pendingAction = { kind, text, at: Date.now() }
    log('click kind=' + kind + ' text=' + text)
    return sendJson(res, 200, { ok: true })
  }

  if (webServer !== undefined && typeof webServer.register === 'function') {
    try {
      ctx.effect(() => {
        const offClick = webServer.register({ kind: 'exact', path: CLICK_PATH, handler: onClick })
        const offPending = webServer.register({ kind: 'exact', path: PENDING_PATH, handler: onPending })
        const offStatus = webServer.register({ kind: 'exact', path: STATUS_PATH, handler: onStatus })
        return () => {
          offClick()
          offPending()
          offStatus()
        }
      })
    } catch (error) {
      log('route-failed ' + String(error))
    }
  }

  /** activate.ps1 needs the live origin and the Desktop executable to focus. */
  try {
    if (origin !== '') writeFileSync(STATE_FILE, JSON.stringify({ origin, exe: process.execPath }), 'utf8')
  } catch (error) {
    log('state-failed ' + String(error))
  }

  function runProtocolScript(remove) {
    const shell = config.powershellPath !== '' ? config.powershellPath : WINDOWS_POWERSHELL
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      PROTOCOL_SCRIPT,
      '-ActivateScript',
      ACTIVATE_SCRIPT,
    ]
    if (remove) args.push('-Remove')
    try {
      const child = spawn(shell, args, { windowsHide: true, stdio: 'ignore' })
      child.on('error', (error) => log('protocol-error ' + String(error)))
      child.on('exit', (code) => log('protocol exit=' + String(code) + ' remove=' + String(remove)))
    } catch (error) {
      log('protocol-spawn-failed ' + String(error))
    }
  }

  if (config.clickToFocus) runProtocolScript(false)

  ctx.effect(() => () => {
    if (config.clickToFocus) runProtocolScript(true)
    try {
      unlinkSync(STATE_FILE)
    } catch {
      /* already gone */
    }
  })

  /** True for the session the user is actually driving, after optional subagent opt-in. */
  function isRootAgent(agent) {
    if (config.includeSubagents) return true
    if (!agent || typeof agent !== 'object' || agent.id === undefined) return true
    let subagents
    try {
      subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
    } catch {
      subagents = undefined
    }
    if (!subagents || typeof subagents.rootOf !== 'function') return true
    try {
      const root = subagents.rootOf(agent)
      if (root && root.id !== undefined && root.id !== agent.id) return false
    } catch {
      /* an unresolvable root keeps the notification rather than dropping it */
    }
    return true
  }

  /** Run toast.ps1 once; resolves on exit, spawn error, or a 15s timeout. */
  function showToast(title, body, click) {
    const shell = config.powershellPath !== '' ? config.powershellPath : WINDOWS_POWERSHELL
    const logo = config.showLogo
      ? config.logoPath !== '' && existsSync(config.logoPath)
        ? config.logoPath
        : existsSync(DEFAULT_LOGO)
          ? DEFAULT_LOGO
          : ''
      : ''
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      TOAST_SCRIPT,
      '-Title',
      title,
      '-Body',
      body,
      '-AppId',
      appId,
      '-Sound',
      config.playSound ? 'default' : 'silent',
    ]
    if (logo !== '') args.push('-Icon', logo)
    if (click !== undefined) {
      const launch =
        PROTOCOL_SCHEME +
        '://click?kind=' +
        encodeURIComponent(click.kind) +
        '&text=' +
        encodeURIComponent(click.text ?? '')
      args.push('-Launch', launch)
    }
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(shell, args, { windowsHide: true, stdio: 'ignore', detached: false })
      } catch (error) {
        log('spawn-failed ' + String(error))
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        finish()
      }, 15000)
      timer.unref?.()
      child.on('error', (error) => {
        log('child-error ' + String(error))
        finish()
      })
      child.on('exit', (code) => {
        log('shown exit=' + String(code) + ' title=' + title)
        finish()
      })
    })
  }

  /** Show the next queued toast after the configured gap. */
  function drain() {
    if (disposed || running || pending.length === 0) return
    const wait = config.minGapMs - (Date.now() - lastShownAt)
    if (wait > 0) {
      drainTimer = setTimeout(drain, wait)
      drainTimer.unref?.()
      return
    }
    const next = pending.shift()
    running = true
    showToast(next.title, next.body, next.click).finally(() => {
      running = false
      lastShownAt = Date.now()
      drain()
    })
  }

  /** Deduplicate, cap the queue, and enqueue one toast. */
  function enqueue(kind, title, body, scope = '') {
    if (disposed) return
    const heading = truncate(title)
    if (heading === '') return
    const content = truncate(body)
    log('enqueue kind=' + kind + ' title=' + heading + ' body=' + content + ' scope=' + String(scope))
    const signature = kind + '\u0000' + scope + '\u0000' + heading + '\u0000' + content
    const now = Date.now()
    const seen = recent.get(signature)
    if (seen !== undefined && now - seen < config.dedupeMs) {
      log('suppressed-duplicate ' + signature)
      return
    }
    recent.set(signature, now)
    for (const [key, at] of recent) {
      if (now - at > Math.max(config.dedupeMs, 30000)) recent.delete(key)
    }
    if (pending.length >= 8) pending.shift()
    const click = config.clickToFocus ? { kind, text: content } : undefined
    pending.push({ title: heading, body: content, click })
    drain()
  }

  /** Question notification; the waterfall must always continue with `next()`. */
  async function onUserQuestion(agent, request, next) {
    log('question-event agent=' + String(agent && agent.id))
    try {
      if (config.onQuestion && isRootAgent(agent)) {
        const items = Array.isArray(request?.questions) ? request.questions : []
        const summary = items
          .map((item) => (item && typeof item.question === 'string' ? item.question : ''))
          .filter((line) => line !== '')
          .join(' / ')
        if (summary !== '') enqueue('question', config.questionTitle, summary, agent && agent.id)
      }
    } catch (error) {
      log('question-hook-failed ' + String(error))
    }
    return next()
  }

  /** Approval notification; the waterfall must always continue with `next()`. */
  async function onApproval(agent, request, next) {
    try {
      if (config.onApproval && isRootAgent(agent)) {
        const detail = localized(
          request && request.displayReason,
          text(request && request.reason, '') !== ''
            ? request.reason
            : '工具 ' + text(request && request.toolName, '未知工具') + ' 需要你的授权',
        )
        enqueue('approval', config.approvalTitle, detail, agent && agent.id)
      }
    } catch (error) {
      log('approval-hook-failed ' + String(error))
    }
    return next()
  }

  /*
   * The two decision events are waterfalls: the Web GUI answerer claims a
   * request and waits for the human, so an observer registered later would
   * never run. `prepend` puts this notification first, and `next()` keeps the
   * real answerer in charge.
   */
  ctx.on('agent/turn-stopping', (payload) => {
    if (!config.onComplete) return
    const signal = payload && payload.signal
    if (signal && signal.aborted === true) return
    if (!isRootAgent(payload && payload.agent)) return
    enqueue('complete', config.completeTitle, config.completeBody, payload && payload.agent && payload.agent.id)
  })

  ctx.on(
    'user-questions/request',
    (request, next) => onUserQuestion(request && request.agent, request, next),
    { prepend: true },
  )

  ctx.on(
    'approval/request',
    (request, next) => onApproval(request && request.agent, request, next),
    { prepend: true },
  )

  log('plugin-ready build=5 appId=' + appId + ' fallback=' + POWERSHELL_FALLBACK_APP_ID)

  ctx.effect(() => () => {
    disposed = true
    if (drainTimer) clearTimeout(drainTimer)
    pending.length = 0
  })
}
