/**
 * The consent step of Supabase Auth's OAuth server, used by the Claude
 * connector (supabase/functions/mcp).
 *
 * Auth sends the user to CONSENT_PATH?authorization_id=… (the "Authorization
 * path" set under Authentication → OAuth Server). Someone not signed in goes
 * through the Zoho sign-in first, and zoho-auth always lands back on "/", so
 * the request is kept in sessionStorage across that round trip.
 */

export const CONSENT_PATH = '/oauth/consent';

const KEY = 'oauth_consent_request';

/**
 * Past this, a remembered request is ignored: it has expired at Auth anyway,
 * and an abandoned one must not take over a later, ordinary sign-in.
 */
const MAX_AGE_MS = 10 * 60_000;

/** Before leaving for Zoho: keep the consent request, if that is where the user is. */
export function rememberConsentRequest(): void {
    if (window.location.pathname !== CONSENT_PATH) return;
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ search: window.location.search, at: Date.now() }));
    } catch { /* storage blocked */ }
}

/** After the sign-in: the consent page to go back to, if a recent request is waiting. */
export function pendingConsentUrl(): string | null {
    try {
        const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { search?: unknown; at?: unknown } | null;
        if (!saved || typeof saved.search !== 'string' || typeof saved.at !== 'number') return null;
        if (Date.now() - saved.at > MAX_AGE_MS) return null;
        return `${CONSENT_PATH}${saved.search}`;
    } catch {
        return null;
    }
}

export function clearPendingConsent(): void {
    try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
