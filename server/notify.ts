// Events and decisions go to the common event log (the `notify` service), as
// required for every service in the stack. Best effort: if notify is down the
// event is still printed to stdout, and the caller is never blocked.

export type Level = 'debug' | 'info' | 'warning' | 'error' | 'alert'

export type Notifier = (level: Level, text: string, title?: string) => void

export function makeNotifier(url: string | undefined, source = 'planner'): Notifier {
  return (level, text, title) => {
    console.log(new Date().toISOString(), level, title ? `${title}: ${text}` : text)
    if (!url) return
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, level, text, ...(title ? { title } : {}) }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => console.log(new Date().toISOString(), 'notify unreachable:', String(err)))
  }
}

export const silent: Notifier = () => {}
