/**
 * Client half of dsh-native-toast.
 *
 * The Host records a click in `/api/dsh-native-toast/pending` when the OS
 * launches the toast protocol; this module polls that route and performs the
 * scroll the click asks for. It renders nothing: no slot is registered and no
 * DOM is created, so the page looks identical with or without the plugin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-native-toast',
  factory(require) {
    const PENDING = '/api/dsh-native-toast/pending'
    const POLL_MS = 1500

    /** The tallest scrollable column right of the sidebar, i.e. the transcript. */
    function findTranscript() {
      let best = null
      const elements = document.querySelectorAll('div, main, section')
      for (const element of elements) {
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

    function revealQuestion(needle) {
      const node = findQuestionNode(needle)
      if (node === null) {
        scrollToBottom()
        return
      }
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      let scope = node
      for (let depth = 0; depth < 7 && scope !== null; depth += 1) {
        const target = scope.querySelector('button, [role="button"], [role="radio"], input[type="radio"]')
        if (target !== null) {
          target.focus({ preventScroll: true })
          return
        }
        scope = scope.parentElement
      }
    }

    function handle(action) {
      if (action === null || typeof action !== 'object') return
      if (action.kind === 'question' || action.kind === 'approval') {
        revealQuestion(action.text)
        return
      }
      scrollToBottom()
    }

    return {
      apply(ctx) {
        let since = 0
        let busy = false

        async function tick() {
          if (busy || document.hidden) return
          busy = true
          try {
            const response = await fetch(PENDING + '?since=' + since, { cache: 'no-store' })
            if (response.ok) {
              const body = await response.json()
              if (body && body.action) {
                since = body.action.at
                handle(body.action)
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
      },
    }
  },
})
