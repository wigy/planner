// Users and linked Google accounts. Signing in with Google is the login: the
// same consent gives calendar access. Only allowlisted addresses may log in; a
// logged-in user may link further Google accounts of any address.

import type { User } from '../shared/types.ts'
import { all, type Db, get, now, run } from './db.ts'
import { Forbidden } from './errors.ts'
import { type CalendarApi, GoogleAuthError, GoogleCalendarApi, idTokenClaims, type OAuthConfig, refreshAccess, type TokenReply } from './google.ts'
import { decrypt, encrypt } from './secrets.ts'

export type AccountRow = { id: number; user_id: number; email: string; refresh_token_enc: string | null; scopes: string; status: string }

export function userJson(u: { id: number; name: string; primary_email: string }): User {
  return { id: u.id, name: u.name, email: u.primary_email }
}

export function getUser(db: Db, id: number): User | undefined {
  const u = get<{ id: number; name: string; primary_email: string }>(db, 'SELECT * FROM users WHERE id = ?', id)
  return u && userJson(u)
}

export function allUsers(db: Db): User[] {
  return all<{ id: number; name: string; primary_email: string }>(db, 'SELECT * FROM users ORDER BY id').map(userJson)
}

export function findOrCreateUser(db: Db, email: string, name: string): User {
  const existing = get<{ id: number; name: string; primary_email: string }>(db, 'SELECT * FROM users WHERE primary_email = ?', email)
  if (existing) return userJson(existing)
  const r = run(db, 'INSERT INTO users (name, primary_email, created_at) VALUES (?, ?, ?)', name || email.split('@')[0], email, now())
  return getUser(db, Number(r.lastInsertRowid))!
}

/**
 * Completes an OAuth callback. For a login (linkTo undefined) the Google address
 * must be allowlisted; it becomes, or finds, the user. For a link the account is
 * attached to the logged-in user. Returns the user and the account id.
 */
export function acceptTokens(
  db: Db,
  key: Buffer,
  tokens: TokenReply,
  allowed: string[],
  linkTo?: number,
): { user: User; accountId: number; isNewAccount: boolean } {
  if (!tokens.id_token) throw new Error('Google sent no ID token')
  const claims = idTokenClaims(tokens.id_token)
  const email = claims.email?.toLowerCase()
  if (!email || claims.email_verified === false) throw new Forbidden('Google did not give a verified address')
  let userId: number
  const existingAccount = get<AccountRow>(db, 'SELECT * FROM google_accounts WHERE email = ?', email)
  if (linkTo !== undefined) {
    if (existingAccount && existingAccount.user_id !== linkTo) throw new Forbidden(`${email} is already linked to another user`)
    userId = linkTo
  } else {
    if (!allowed.includes(email)) throw new Forbidden(`${email} is not allowed to log in here`)
    const owner = existingAccount?.user_id
    userId = owner ?? findOrCreateUser(db, email, claims.name ?? '').id
  }
  const sealed = tokens.refresh_token ? encrypt(key, tokens.refresh_token) : null
  let accountId: number
  if (existingAccount) {
    accountId = existingAccount.id
    // Google sends a refresh token only with consent; keep the old one otherwise.
    run(db, "UPDATE google_accounts SET refresh_token_enc = coalesce(?, refresh_token_enc), scopes = ?, status = 'ok' WHERE id = ?",
      sealed, tokens.scope ?? existingAccount.scopes, accountId)
  } else {
    const r = run(db, 'INSERT INTO google_accounts (user_id, email, refresh_token_enc, scopes) VALUES (?, ?, ?, ?)', userId, email, sealed, tokens.scope ?? '')
    accountId = Number(r.lastInsertRowid)
  }
  if (claims.name) run(db, 'UPDATE users SET name = ? WHERE id = ? AND primary_email = ?', claims.name, userId, email)
  rememberAccess(accountId, tokens)
  return { user: getUser(db, userId)!, accountId, isNewAccount: !existingAccount }
}

// Access tokens live in memory only, an hour at a time.
const access = new Map<number, { token: string; expires: number }>()

function rememberAccess(accountId: number, t: TokenReply) {
  access.set(accountId, { token: t.access_token, expires: Date.now() + (t.expires_in - 120) * 1000 })
}

export function apiFactory(db: Db, key: Buffer, cfg: OAuthConfig | null): (accountId: number) => CalendarApi {
  return (accountId) =>
    new GoogleCalendarApi(async () => {
      const cached = access.get(accountId)
      if (cached && cached.expires > Date.now()) return cached.token
      if (!cfg) throw new GoogleAuthError('Google OAuth is not configured')
      const row = get<AccountRow>(db, 'SELECT * FROM google_accounts WHERE id = ?', accountId)
      if (!row?.refresh_token_enc) throw new GoogleAuthError(`no refresh token for account ${accountId}`)
      const t = await refreshAccess(cfg, decrypt(key, row.refresh_token_enc))
      rememberAccess(accountId, t)
      return t.access_token
    })
}

export function accountsOf(db: Db, userId: number): { id: number; email: string; status: string }[] {
  return all(db, 'SELECT id, email, status FROM google_accounts WHERE user_id = ? ORDER BY id', userId)
}
