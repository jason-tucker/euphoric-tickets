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

// POST a JSON body to the copium API. Returns the 2xx Response, or null after
// logging a warning (status / timeout / network — never the token or body).
async function copiumPost(d: CopiumDeps, path: string, body: unknown, what: string): Promise<Response | null> {
  const endpoint = `${d.apiBase.replace(/\/+$/, '')}${path}`
  let res: Response
  try {
    res = await d.fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${d.token}`,
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(d.timeoutMs),
    })
  } catch (err) {
    const name = typeof (err as { name?: unknown })?.name === 'string' ? (err as { name: string }).name : ''
    log.warn(`copium ${what} request failed`, {
      reason: name === 'TimeoutError' ? 'timeout' : 'network',
      err: name || String(err),
    })
    return null
  }
  if (!res.ok) {
    // The body is a short {"error": "..."} — safe to log a slice of it; it
    // never echoes the token.
    const detail = await res.text().catch(() => '')
    log.warn(`copium ${what} rejected`, { status: res.status, error: detail.slice(0, 200) })
    return null
  }
  return res
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown> | null> {
  try {
    const json = (await res.json()) as unknown
    if (json && typeof json === 'object') return json as Record<string, unknown>
  } catch {
    // fall through
  }
  log.warn(`copium ${what}: response was not a JSON object`, { status: res.status })
  return null
}

// Returns the paste's link (host rewritten) and its id (needed for album adds;
// null if copium omitted it), or null on any failure.
export async function createPaste(
  input: { title: string; content: string },
  deps: Partial<CopiumDeps> = {},
): Promise<{ id: string | null; url: string } | null> {
  const d = { ...defaultDeps(), ...deps }
  if (!d.token) return null

  const res = await copiumPost(d, '/api/paste', { title: input.title, content: input.content, language: 'plaintext' }, 'paste')
  if (!res) return null
  const json = await readJson(res, 'paste')
  if (!json) return null

  const { pageUrl, id } = json
  if (typeof pageUrl !== 'string' || !pageUrl) {
    log.warn('copium paste: response had no pageUrl', { status: res.status })
    return null
  }
  try {
    return { id: typeof id === 'string' && id ? id : null, url: rewriteLinkHost(pageUrl, d.linkHost) }
  } catch {
    log.warn('copium paste: pageUrl was not a valid URL', { status: res.status })
    return null
  }
}

// Adds uploads/pastes to a copium album. true only on 2xx with added >= 1.
// Never throws.
export async function addToAlbum(albumId: string, ids: string[], deps: Partial<CopiumDeps> = {}): Promise<boolean> {
  const d = { ...defaultDeps(), ...deps }
  if (!d.token || !albumId || ids.length === 0) return false

  const res = await copiumPost(d, `/api/albums/${encodeURIComponent(albumId)}/images`, { imageIds: ids }, 'album add')
  if (!res) return false
  const json = await readJson(res, 'album add')
  if (!json) return false
  if (typeof json.added !== 'number' || json.added < 1) {
    log.warn('copium album add: nothing was added', { status: res.status, added: json.added ?? null })
    return false
  }
  return true
}
