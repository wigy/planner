import { describe, expect, it } from 'vitest'
import { hashtags, parseBooking, renameHashtag, setBooking } from './hashtag.ts'

describe('hashtags', () => {
  it('finds hashtags at the start or after whitespace, case-insensitively', () => {
    expect(hashtags('#Acme sprint review #meeting')).toEqual(['acme', 'meeting'])
    expect(hashtags('Review (#acme), then lunch')).toEqual([])
    expect(hashtags('Review #acme, then lunch')).toEqual(['acme'])
  })
  it('ignores a hashtag inside a word or a URL fragment', () => {
    expect(hashtags('a#acme https://x.example/page#section')).toEqual([])
  })
  it('lists each tag once', () => {
    expect(hashtags('#a #A #b')).toEqual(['a', 'b'])
  })
})

describe('parseBooking', () => {
  const known = ['acme', 'tasenor']
  it('books one known hashtag', () => {
    expect(parseBooking('Sprint review #ACME', known)).toEqual({ kind: 'booked', hashtag: 'acme', unknown: [] })
  })
  it('refuses two project hashtags', () => {
    expect(parseBooking('Call #acme #tasenor', known)).toEqual({ kind: 'conflict', hashtags: ['acme', 'tasenor'], unknown: [] })
  })
  it('reports unknown hashtags without booking', () => {
    expect(parseBooking('Call #zeta', known)).toEqual({ kind: 'none', unknown: ['zeta'] })
  })
})

describe('setBooking', () => {
  const known = ['acme', 'tasenor']
  it('appends the hashtag', () => {
    expect(setBooking('Sprint review', 'acme', known)).toBe('Sprint review #acme')
  })
  it('swaps the project hashtag and keeps others', () => {
    expect(setBooking('Sprint #acme review #meeting', 'tasenor', known)).toBe('Sprint review #meeting #tasenor')
  })
  it('unbooks', () => {
    expect(setBooking('Sprint review #acme', null, known)).toBe('Sprint review')
  })
  it('handles an empty title', () => {
    expect(setBooking('', 'acme', known)).toBe('#acme')
  })
})

describe('renameHashtag', () => {
  it('keeps the place of the tag', () => {
    expect(renameHashtag('#Acme standup', 'acme', 'aw')).toBe('#aw standup')
    expect(renameHashtag('a#acme #acme', 'acme', 'aw')).toBe('a#acme #aw')
  })
})

describe('descriptions', () => {
  it('finds tags inside HTML and keeps the layout when removing them', async () => {
    const { hashtags, removeHashtagsKeepLayout } = await import('./hashtag.ts')
    expect(hashtags('<p>#Acme</p>&nbsp;x #b, https://x/y#d')).toEqual(['acme', 'b'])
    expect(removeHashtagsKeepLayout('Work on\n<p>#acme</p>\nmore #acme here', ['acme'])).toBe('Work on\n<p></p>\nmore here')
  })
})

describe('descriptionText', () => {
  it('turns Google HTML into plain lines without the project tags', async () => {
    const { descriptionText } = await import('./hashtag.ts')
    expect(descriptionText('Refactoring<br>tests &amp; docs<p>#acme</p>', ['acme'])).toBe('Refactoring\ntests & docs')
    expect(descriptionText('<ul><li>one</li><li>two #other</li></ul>', ['acme'])).toBe('• one\n• two #other')
  })
})
