/**
 * Telling failures apart. A dropped connection or an overloaded server is worth one retry; a used-up
 * plan, a missing CLI or a bad model will fail the same way again, so they aren't.
 */

const PERMANENT =
  /usage limit|rate.?limit|quota|too many requests|\b429\b|not logged in|sign in to|log ?in required|unauthori[sz]ed|not found on PATH|isn't available|isn't in the model menu|rejected a flag|not supported when using|subscription|upgrade your plan|billing|payment|the tab was closed|closed or reloaded|copy & paste mode|message box|aborted/i;

const TRANSIENT =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|connection (?:reset|refused|closed|error)|\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway time-?out|overloaded|temporarily|try again|something went wrong|stream (?:ended|disconnected)|timed out waiting for the reply to start/i;

/** Worth retrying once: looks like a hiccup, not something that will fail the same way again. */
export function isTransient(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return TRANSIENT.test(msg) && !PERMANENT.test(msg);
}

/** Looks like the machine can't reach the services at all. */
export function looksOffline(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|network|fetch failed|offline|internet/i.test(msg);
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
