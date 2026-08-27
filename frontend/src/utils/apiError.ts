import { ApiError } from '@ignite/api/client';

/** The sentence to show a user for a failed request. `ApiError.message` is the
 * transport's own placeholder — the literal 'Request failed' — so reading it
 * discards the server's actionable explanation, which arrives in `body`. */
export function apiErrorMessage(reason: unknown): string {
  return reason instanceof ApiError
    ? (reason.body.message ?? reason.message)
    : reason instanceof Error
      ? reason.message
      : String(reason);
}
