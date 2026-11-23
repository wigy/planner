// Markdown for descriptions and comments. Raw HTML is shown as text and only
// http(s)/mailto links are kept, since the other user's board is shown too.

import { Marked } from 'marked'

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      return escape(token.text)
    },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (!/^(https?:|mailto:)/i.test(href)) return text
      return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    },
    image({ href, text }) {
      if (!/^https?:/i.test(href)) return escape(text)
      return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(text || href)}</a>`
    },
  },
})

export function renderMarkdown(text: string): string {
  return md.parse(text, { async: false }) as string
}
