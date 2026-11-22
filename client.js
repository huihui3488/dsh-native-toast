/**
 * Client half of dsh-native-toast.
 *
 * The Host records a click in `/api/dsh-native-toast/pending` when the OS
 * launches the toast protocol; this module polls that route, switches to the
 * Session the toast belongs to when the page shows another one, then scrolls
 * the conversation so the assistant output of the latest turn starts near the
 * top of the transcript. A pending question gets its first option focused.
 */
window.__ModuleLoader__.load({
  id: 'dsh-native-toast',
  factory(require) {
    const PENDING = '/api/dsh-native-toast/pending'
    const REPORT = '/api/dsh-native-toast/report'
    const POLL_MS = 1500
    const SWITCH_TIMEOUT_MS = 4000
    const OUTPUT_TOP_GAP = 24

    let currentSession = ''

    /** Empty slot entry whose only job is to report the open Session id. */
    function SessionProbe(props) {
      currentSession = typeof props.sessionId === 'string' ? props.sessionId : ''
      return null
    }

    function findTranscript() {
      const explicit = document.querySelector('[data-conversation-scroll]')
      if (explicit !== null) return explicit
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

    /** First node of the newest turn: its collapsed process row starts the output. */
    function outputAnchor() {
      const nodes = Array.from(document.querySelectorAll('[data-chat-node-key]'))
      if (nodes.length === 0) return null
      const last = nodes[nodes.length - 1]
      const turn = last.getAttribute('data-chat-turn')
      if (turn === null) return last
      const inTurn = nodes.filter((node) => node.getAttribute('data-chat-turn') === turn)
      const process = inTurn.find((node) => node.getAttribute('data-chat-flow-kind') === 'turn-process')
      return process ?? inTurn[0] ?? null
    }

    function scrollToBottom(transcript) {
      if (transcript === null) {
        window.scrollTo({ top: document.body.scrollHeight })
        return
      }
      transcript.scrollTop = transcript.scrollHeight
    }

    /** Put the start of the latest assistant output `OUTPUT_TOP_GAP` below the top. */
    function scrollToOutputStart(instant) {
      const behavior = instant === true ? 'auto' : 'smooth'
      const transcript = findTranscript()
      const anchor = outputAnchor()
      if (anchor === null) {
        scrollToBottom(transcript)
        return
      }
      if (transcript === null) {
        anchor.scrollIntoView({ block: 'start', behavior })
        return
      }
      const offset =
        anchor.getBoundingClientRect().top -
        transcript.getBoundingClientRect().top +
        transcript.scrollTop -
        OUTPUT_TOP_GAP
      transcript.scrollTo({
        top: Math.max(0, Math.min(offset, transcript.scrollHeight - transcript.clientHeight)),
        behavior,
      })
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

    /** Focus the question's first option without moving the scroll position. */
    function focusQuestion(needle) {
      const node = findQuestionNode(needle)
      if (node === null) return false
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

    function retryFocus(action, attempt) {
      if (attempt >= 10) return
      if (!focusQuestion(action.text)) setTimeout(() => retryFocus(action, attempt + 1), 200)
    }

    function reportScroll(action) {
      try {
        const transcript = findTranscript()
        const anchor = outputAnchor()
        const scrollers = Array.from(document.querySelectorAll('[data-conversation-scroll]')).map((element) => ({
          id: element.getAttribute('data-conversation-scroll') || '',
          top: Math.round(element.scrollTop),
          max: Math.round(element.scrollHeight - element.clientHeight),
          h: element.clientHeight,
        }))
        const detail = {
          kind: action.kind,
          transcript: transcript === null ? 'none' : {
            top: Math.round(transcript.scrollTop),
            max: Math.round(transcript.scrollHeight - transcript.clientHeight),
            h: transcript.clientHeight,
          },
          scrollers,
          anchor: anchor === null ? 'none' : {
            turn: anchor.getAttribute('data-chat-turn'),
            flow: anchor.getAttribute('data-chat-flow-kind'),
            offset: transcript === null
              ? -1
              : Math.round(anchor.getBoundingClientRect().top - transcript.getBoundingClientRect().top),
          },
        }
        void fetch(REPORT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dom: JSON.stringify(detail) }),
        }).catch(() => {})
      } catch {
        /* diagnosis only */
      }
    }

    let lastAction = 0
    function act(action) {
      scrollToOutputStart(false)
      if (action.kind === 'question' || action.kind === 'approval') retryFocus(action, 0)
      setTimeout(() => scrollToOutputStart(true), 550)
      if (Date.now() !== lastAction) {
        lastAction = Date.now()
        setTimeout(() => reportScroll(action), 1400)
      }
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
              const url = PENDING + '?since=' + since + '&cur=' + encodeURIComponent(currentSession)
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

          void fetch(PENDING + '?since=0&hello=1&cur=' + encodeURIComponent(currentSession), {
            cache: 'no-store',
          }).catch(() => {})
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          void fetch(PENDING + '?since=0&hello=1&err=' + encodeURIComponent(message), {
            cache: 'no-store',
          }).catch(() => {})
          throw error
        }
      },
    }
  },
})

