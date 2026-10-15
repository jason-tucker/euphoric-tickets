import { env } from '../config/env'
import { log } from './logger'

// copium.pics text pastes (v0.9.0). On close, the plain-text transcript is
// posted as a paste so the opener DM and the web dashboard
// (tickets.external_transcript_url) can link to it. Best-effort: every failure
// returns null and closing carries on without the link.
//
// The token is a secret — it is only ever put in the Authorization header,
// never logged. Paste content is never logged either.

export const COPIUM_TIMEOUT_MS = 15_000

export type CopiumDeps = {
  fetch: typeof fetch
  token: string | undefined
  apiBase: string
  linkHost: string | undefined
  timeoutMs: number
}

// Defaults are read at call time so tests (and a future hot-reload) see the
// current env / global fetch. Tests pass `deps` instead of patching globals.
function defaultDeps(): CopiumDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    token: env.COPIUM_TOKEN,
    apiBase: env.COPIUM_API_BASE,
    linkHost: env.COPIUM_LINK_HOST,
    timeoutMs: COPIUM_TIMEOUT_MS,
  }
}

export function isCopiumEnabled(deps: Partial<CopiumDeps> = {}): boolean {
  return Boolean({ ...defaultDeps(), ...deps }.token)
}

// Swap the pageUrl's host for the configured custom domain
// (https://tucker.copium.pics/i/<id> → https://i.tucker.host/i/<id>).
export function rewriteLinkHost(pageUrl: string, linkHost: string | undefined): string {
  const u = new URL(pageUrl)
  if (linkHost) u.host = linkHost
  return u.toString()
}

export async function createPaste(
  input: { title: string; content: string },
  deps: Partial<CopiumDeps> = {},
): Promise<string | null> {
  const d = { ...defaultDeps(), ...deps }
  if (!d.token) return null

  const endpoint = `${d.apiBase.replace(/\/+$/, '')}/api/paste`
  let res: Response
  try {
    res = await d.fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${d.token}`,
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch',
      },
      body: JSON.stringify({ title: input.title, content: input.content, language: 'plaintext' }),
      signal: AbortSignal.timeout(d.timeoutMs),
    })
  } catch (err) {
    const name = typeof (err as { name?: unknown })?.name === 'string' ? (err as { name: string }).name : ''
    log.warn('copium paste request failed', {
      reason: name === 'TimeoutError' ? 'timeout' : 'network',
      err: name || String(err),
    })
    return null
  }

  if (!res.ok) {
    // The body is a short {"error": "..."} — safe to log a slice of it; it
    // never echoes the token.
    const detail = await res.text().catch(() => '')
    log.warn('copium paste rejected', { status: res.status, error: detail.slice(0, 200) })
    return null
  }

  let pageUrl: unknown
  try {
    pageUrl = ((await res.json()) as { pageUrl?: unknown } | null)?.pageUrl
  } catch {
    log.warn('copium paste: response was not JSON', { status: res.status })
    return null
  }
  if (typeof pageUrl !== 'string' || !pageUrl) {
    log.warn('copium paste: response had no pageUrl', { status: res.status })
    return null
  }

  try {
    return rewriteLinkHost(pageUrl, d.linkHost)
  } catch {
    log.warn('copium paste: pageUrl was not a valid URL', { status: res.status })
    return null
  }
}
