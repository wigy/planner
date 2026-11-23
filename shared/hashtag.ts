// Project hashtags in events: a hashtag in the title or the description is the
// booking. Matching is case-insensitive, and a hashtag must start the text or
// follow whitespace, so `a#acme` and URLs with fragments do not count. Google
// keeps descriptions as HTML, so a tag may also sit right inside a tag (`<p>#acme</p>`).

export const HASHTAG_RE = /^[a-z0-9_-]{1,32}$/

const BEFORE = '(^|[\\s>])'
const AFTER = '(?=$|[\\s.,;:!?)\\]<&])'
const FIND = new RegExp(`${BEFORE}#([a-z0-9_-]{1,32})${AFTER}`, 'gi')

function tagRe(tag: string): RegExp {
  return new RegExp(`${BEFORE}#${escape(tag)}${AFTER}`, 'gi')
}

/** Every hashtag in the text, lower-cased, in order, without duplicates. */
export function hashtags(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(FIND)) {
    const tag = m[2].toLowerCase()
    if (!found.includes(tag)) found.push(tag)
  }
  return found
}

export type Booking =
  | { kind: 'none'; unknown: string[] }
  | { kind: 'booked'; hashtag: string; unknown: string[] }
  | { kind: 'conflict'; hashtags: string[]; unknown: string[] }

/** What a title books, given the user's known project hashtags. */
export function parseBooking(title: string, known: Iterable<string>): Booking {
  const knownSet = new Set([...known].map((k) => k.toLowerCase()))
  const tags = hashtags(title)
  const matched = tags.filter((t) => knownSet.has(t))
  const unknown = tags.filter((t) => !knownSet.has(t))
  if (matched.length === 0) return { kind: 'none', unknown }
  if (matched.length === 1) return { kind: 'booked', hashtag: matched[0], unknown }
  return { kind: 'conflict', hashtags: matched, unknown }
}

/** Removes the given hashtags from a title, tidying the spaces around them. */
export function removeHashtags(title: string, tags: Iterable<string>): string {
  let out = title
  for (const tag of tags) {
    out = out.replace(tagRe(tag), '$1')
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

/** What an event books: the hashtags of its title and its description together. */
export function parseEventBooking(title: string, description: string, known: Iterable<string>): Booking {
  return parseBooking(`${title}\n${description}`, known)
}

/** Removes hashtags from a description, keeping its lines and markup as they are. */
export function removeHashtagsKeepLayout(text: string, tags: Iterable<string>): string {
  let out = text
  for (const tag of tags) out = out.replace(tagRe(tag), '$1')
  return out.replace(/([^\s]) {2,}/g, '$1 ').replace(/ +(\n|$)/g, '$1')
}

/**
 * The title and description booked to `tag` (or to nothing). The title is
 * changed only if it already carries a project hashtag, which is then swapped in
 * place; otherwise the hashtag goes into the description, in place of a project
 * hashtag already there or appended on a line of its own.
 */
export function setEventBooking(title: string, description: string, tag: string | null, known: Iterable<string>): { title: string; description: string } {
  const list = [...known].map((k) => k.toLowerCase())
  const inTitle = hashtags(title).filter((t) => list.includes(t))
  const inDescription = hashtags(description).filter((t) => list.includes(t))
  if (!tag) return { title: removeHashtags(title, inTitle), description: removeHashtagsKeepLayout(description, inDescription) }
  const next = tag.toLowerCase()
  if (inTitle.length > 0) {
    const t = inTitle.length === 1 ? renameHashtag(title, inTitle[0], next) : setBooking(title, next, list)
    return { title: t, description: removeHashtagsKeepLayout(description, inDescription) }
  }
  if (inDescription.length === 1) return { title, description: renameHashtag(description, inDescription[0], next) }
  const rest = removeHashtagsKeepLayout(description, inDescription).replace(/\s+$/, '')
  if (!rest) return { title, description: `#${next}` }
  return { title, description: /<[a-z][^>]*>/i.test(rest) ? `${rest}<br>#${next}` : `${rest}\n#${next}` }
}

/**
 * The title booked to `tag` (or to nothing when null): every known project
 * hashtag is removed first, so a title never carries two of them, and the new
 * one is appended.
 */
export function setBooking(title: string, tag: string | null, known: Iterable<string>): string {
  const base = removeHashtags(title, known)
  if (!tag) return base
  return base ? `${base} #${tag.toLowerCase()}` : `#${tag.toLowerCase()}`
}

/** Replaces hashtag `from` with `to`, keeping its place in the title. */
export function renameHashtag(title: string, from: string, to: string): string {
  return title.replace(tagRe(from), `$1#${to.toLowerCase()}`)
}

function escape(s: string): string {
  return s.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')
}

/**
 * An event description as plain text for reports: Google's HTML turned into
 * lines, and the given hashtags (the projects') taken out, since the project is
 * shown anyway.
 */
export function descriptionText(description: string, tags: Iterable<string>): string {
  const text = description
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|ul|ol|h\d)(\s[^>]*)?>/gi, '\n')
    .replace(/<li(\s[^>]*)?>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  return removeHashtagsKeepLayout(text, tags)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
}
