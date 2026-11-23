// Session cookies and encryption of the stored refresh tokens.
//
// A session token is `<user id>.<issued ms>.<hmac>`; the HMAC is over the id and
// the issue time, keyed with the server secret. Refresh tokens are encrypted with
// AES-256-GCM under a separate key, so a copy of the database alone (a backup,
// say) does not give access to anyone's calendar.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A 32-byte key from base64 in the environment, else from a file in the data dir (created once). */
export function loadKey(envValue: string | undefined, dataDir: string, file: string): Buffer {
  if (envValue) {
    const key = Buffer.from(envValue, 'base64')
    if (key.length !== 32) throw new Error(`${file}: the key must be 32 bytes of base64`)
    return key
  }
  const path = join(dataDir, file)
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 })
  return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
}

function mac(secret: Buffer, text: string): string {
  return createHmac('sha256', secret).update(text).digest('base64url')
}

export function signSession(secret: Buffer, userId: number, issued = Date.now()): string {
  const body = `${userId}.${issued}`
  return `${body}.${mac(secret, body)}`
}

export function verifySession(secret: Buffer, token: string, maxAgeMs: number): number | null {
  const [id, issued, sig] = token.split('.')
  if (!id || !issued || !sig) return null
  const expected = Buffer.from(mac(secret, `${id}.${issued}`))
  const given = Buffer.from(sig)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  if (Date.now() - Number(issued) > maxAgeMs) return null
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** A short-lived signed value, used for the OAuth state cookie. */
export function signValue(secret: Buffer, value: string): string {
  return `${value}.${mac(secret, `state:${value}`)}`
}

export function verifyValue(secret: Buffer, signed: string): string | null {
  const dot = signed.lastIndexOf('.')
  if (dot < 1) return null
  const value = signed.slice(0, dot)
  const expected = Buffer.from(mac(secret, `state:${value}`))
  const given = Buffer.from(signed.slice(dot + 1))
  return given.length === expected.length && timingSafeEqual(given, expected) ? value : null
}

export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')
}

export function decrypt(key: Buffer, sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
