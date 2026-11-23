// Project hashtags in event titles: the hashtag in a Bookkeeping event's title is
// the booking. Matching is case-insensitive, and a hashtag must start the title or
// follow whitespace, so `a#acme` and URLs with fragments do not count.

export const HASHTAG_RE = /^[a-z0-9_-]{1,32}$/

const FIND = /(^|\s)#([a-z0-9_-]{1,32})(?=$|[\s.,;:!?)\]])/gi

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
    const re = new RegExp(`(^|\\s)#${escape(tag)}(?=$|[\\s.,;:!?)\\]])`, 'gi')
    out = out.replace(re, '$1')
  }
  return out.replace(/\s{2,}/g, ' ').trim()
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
  const re = new RegExp(`(^|\\s)#${escape(from)}(?=$|[\\s.,;:!?)\\]])`, 'gi')
  return title.replace(re, `$1#${to.toLowerCase()}`)
}

function escape(s: string): string {
  return s.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')
}
