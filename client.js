/**
 * Client half of dsh-native-toast.
 *
 * The Host records a click in `/api/dsh-native-toast/pending` when the OS
 * launches the toast protocol; this module polls that route, switches to the
 * Session the toast belongs to when the page shows another one, then scrolls
 * to the finished turn or reveals the pending question. It renders only an
 * empty probe that reports the currently open Session; no visible UI.
 */
window.__ModuleLoader__.load({
  id: 'dsh-native-toast',
  factory(require) {
    const PENDING = '/api/dsh-native-toast/pending'
    const POLL_MS = 1500
    const SWITCH_TIMEOUT_MS = 4000

    let currentSession = ''

    /** Empty slot entry whose only job is to report the open Session id. */
    function SessionProbe(props) {
      currentSession = typeof props.sessionId === 'string' ? props.sessionId : ''
      return null
    }

    /** The tallest scrollable column right of the sidebar, i.e. the transcript. */
    function findTranscript() {
      let best = null
      for (const element of document.querySelectorAll('div, main, section')) {
        const style = getComputedStyle(element)
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue
        if (element.scrollHeight - element.clientHeight < 24) continue
        const rect = element.getBoundingClientRect()
        if (rect.width < 320 || rect.height < 160) continue
        if (rect.left < 120) continue
        if (best === null || element.scrollHeight > best.scrollHeight) best = element
      }
      return best
    }

    function scrollToBottom() {
      const transcript = findTranscript()
      if (transcript === null) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
        return
      }
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' })
    }

    /** The last visible node showing the pending question text. */
    function findQuestionNode(needle) {
      const probe = String(needle || '').trim().slice(0, 24)
      if (probe === '') return null
      let found = null
      let foundTop = -Infinity
      for (const element of document.querySelectorAll('div, span, p, label')) {
        if (element.children.length > 0) continue
        const text = element.textContent
        if (!text || text.indexOf(probe) === -1) continue
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        if (rect.top > foundTop) {
          found = element
          foundTop = rect.top
        }
      }
      return found
    }

    /** Scroll the question into view and focus its first option; false when absent. */
    function revealQuestion(needle) {
      const node = findQuestionNode(needle)
      if (node === null) return false
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      let scope = node
      for (let depth = 0; depth < 7 && scope !== null; depth += 1) {
        const target = scope.querySelector('button, [role="button"], [role="radio"], input[type="radio"]')
        if (target !== null) {
          target.focus({ preventScroll: true })
          return true
        }
        scope = scope.parentElement
      }
      return true
    }

    function retryReveal(action, attempt) {
      if (attempt >= 8) {
        scrollToBottom()
        return
      }
      setTimeout(() => {
        if (!revealQuestion(action.text)) retryReveal(action, attempt + 1)
      }, 250)
    }

    function act(action) {
      if (action.kind === 'question' || action.kind === 'approval') {
        if (!revealQuestion(action.text)) retryReveal(action, 0)
        return
      }
      scrollToBottom()
      setTimeout(scrollToBottom, 400)
    }

    /** After a Session switch the transcript mounts late, so wait for it. */
    function waitForSessionThenAct(action, deadline) {
      if (currentSession === action.session || Date.now() > deadline) {
        act(action)
        return
      }
      setTimeout(() => waitForSessionThenAct(action, deadline), 120)
    }

    function handle(action, uiWorkspace) {
      if (action === null || typeof action !== 'object') return
      const target = typeof action.session === 'string' ? action.session : ''
      const canSwitch =
        target !== '' &&
        currentSession !== '' &&
        target !== currentSession &&
        uiWorkspace !== undefined &&
        typeof uiWorkspace.openSession === 'function'
      if (!canSwitch) {
        act(action)
        return
      }
      try {
        uiWorkspace.openSession(target)
      } catch {
        act(action)
        return
      }
      waitForSessionThenAct(action, Date.now() + SWITCH_TIMEOUT_MS)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let since = 0
        let busy = false

        function report(query) {
          void fetch(PENDING + '?since=' + since + query, { cache: 'no-store' }).catch(() => {})
        }

        try {
          const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined

          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'dsh-native-toast-session', order: 999 },
              SessionProbe,
            ),
          )

          async function tick() {
            if (busy || document.hidden) return
            busy = true
            try {
              const url =
                PENDING +
                '?since=' + since +
                '&cur=' + encodeURIComponent(currentSession) +
                '&hello=0'
              const response = await fetch(url, { cache: 'no-store' })
              if (response.ok) {
                const body = await response.json()
                if (body && body.action) {
                  since = body.action.at
                  handle(body.action, uiWorkspace)
                }
              }
            } catch {
              /* the Host may be restarting; the next tick retries */
            } finally {
              busy = false
            }
          }

          ctx.effect(() => {
            const timer = setInterval(tick, POLL_MS)
            const onVisibility = () => {
              if (!document.hidden) tick()
            }
            document.addEventListener('visibilitychange', onVisibility)
            return () => {
              clearInterval(timer)
              document.removeEventListener('visibilitychange', onVisibility)
            }
          })

          report('&hello=1&cur=' + encodeURIComponent(currentSession))
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          report('&hello=1&err=' + encodeURIComponent(message))
          throw error
        }
      },
    }
  },
})
