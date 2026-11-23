// Errors that the HTTP layer turns into status codes.

export class Invalid extends Error {} // 400
export class Unauthorized extends Error {} // 401
export class Forbidden extends Error {} // 403
export class NotFound extends Error {} // 404
export class Conflict extends Error {} // 409

export function statusOf(err: unknown): number {
  if (err instanceof Invalid) return 400
  if (err instanceof Unauthorized) return 401
  if (err instanceof Forbidden) return 403
  if (err instanceof NotFound) return 404
  if (err instanceof Conflict) return 409
  return 500
}
