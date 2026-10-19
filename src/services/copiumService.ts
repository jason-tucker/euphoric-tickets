import { env } from '../config/env'
import { log } from './logger'

// copium.pics transcripts. On close the Discord-style HTML transcript is
// uploaded (v0.10.0; copium renders it like the real channel on
// transcripts.copium.tools), falling back to a plain-text paste (v0.9.0), so
// the opener DM and the web dashboard (tickets.external_transcript_url) can
// link to it. Best-effort: every failure returns null and closing carries on.
//
// The token is a secret — it is only ever put in the Authorization header,
// never logged. Paste content is never logged either.

export const COPIUM_TIMEOUT_MS = 15_000
// HTML uploads can be large; copium waits for processing (?wait=1).
export const COPIUM_UPLOAD_TIMEOUT_MS = 30_000
// copium's htmlMaxBytes (25 MiB). Larger transcripts skip the upload.
export const COPIUM_HTML_MAX_BYTES = 25 * 1024 * 1024

export type CopiumDeps = {
  fetch: typeof fetch
  token: string | undefined
  apiBase: string
  uploadBase: string
  linkHost: string | undefined
  // Overrides the per-call default (COPIUM_TIMEOUT_MS / COPIUM_UPLOAD_TIMEOUT_MS).
  timeoutMs: number | undefined
}

// Defaults are read at call time so tests (and a future hot-reload) see the
// current env / global fetch. Tests pass `deps` instead of patching globals.
function defaultDeps(): CopiumDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    token: env.COPIUM_TOKEN,
    apiBase: env.COPIUM_API_BASE,
    uploadBase: env.COPIUM_UPLOAD_BASE,
    linkHost: env.COPIUM_LINK_HOST,
    timeoutMs: undefined,
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

// POST to the copium API. A FormData body is sent as multipart (fetch sets
// the boundary); anything else as JSON. Returns the 2xx Response, or null
// after logging a warning (status / timeout / network — never the token or body).
async function copiumPost(
  d: CopiumDeps,
  url: string,
  body: unknown,
  what: string,
  defaultTimeoutMs = COPIUM_TIMEOUT_MS,
): Promise<Response | null> {
  const multipart = body instanceof FormData
  let res: Response
  try {
    res = await d.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${d.token}`,
        ...(multipart ? {} : { 'Content-Type': 'application/json' }),
        'X-Requested-With': 'fetch',
      },
      body: multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(d.timeoutMs ?? defaultTimeoutMs),
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

const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`

function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
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

  const res = await copiumPost(d, join(d.apiBase, '/api/paste'), { title: input.title, content: input.content, language: 'plaintext' }, 'paste')
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

// Uploads a Discord-style HTML transcript (multipart `file` + `title`) to
// <COPIUM_UPLOAD_BASE>/api/upload?wait=1. Returns the full-page transcript
// link (`link`, falling back to `url`, e.g. https://transcripts.copium.tools/
// <id>.html — COPIUM_LINK_HOST is NOT applied) and the upload id, or null on
// any failure. HTML over COPIUM_HTML_MAX_BYTES is skipped without a request.
export async function uploadHtml(
  input: { filename: string; html: string; title: string },
  deps: Partial<CopiumDeps> = {},
): Promise<{ id: string | null; url: string } | null> {
  const d = { ...defaultDeps(), ...deps }
  if (!d.token) return null

  const bytes = Buffer.byteLength(input.html, 'utf8')
  if (bytes > COPIUM_HTML_MAX_BYTES) {
    log.warn('copium upload skipped: transcript HTML is over the size limit', { bytes, max: COPIUM_HTML_MAX_BYTES })
    return null
  }
  const filename = input.filename.toLowerCase().endsWith('.html') ? input.filename : `${input.filename}.html`
  const form = new FormData()
  form.append('file', new Blob([input.html], { type: 'text/html' }), filename)
  form.append('title', input.title)

  const res = await copiumPost(d, join(d.uploadBase, '/api/upload?wait=1'), form, 'upload', COPIUM_UPLOAD_TIMEOUT_MS)
  if (!res) return null
  const json = await readJson(res, 'upload')
  if (!json) return null

  const url = httpUrl(json.link) ?? httpUrl(json.url)
  if (!url) {
    log.warn('copium upload: response had no valid link/url', { status: res.status })
    return null
  }
  if (json.kind !== 'html') log.warn('copium upload: unexpected kind', { status: res.status, kind: json.kind ?? null })
  const { id } = json
  return { id: typeof id === 'string' && id ? id : null, url }
}

// Adds uploads/pastes to a copium album. true only on 2xx with added >= 1.
// Never throws.
export async function addToAlbum(albumId: string, ids: string[], deps: Partial<CopiumDeps> = {}): Promise<boolean> {
  const d = { ...defaultDeps(), ...deps }
  if (!d.token || !albumId || ids.length === 0) return false

  const res = await copiumPost(d, join(d.apiBase, `/api/albums/${encodeURIComponent(albumId)}/images`), { imageIds: ids }, 'album add')
  if (!res) return false
  const json = await readJson(res, 'album add')
  if (!json) return false
  if (typeof json.added !== 'number' || json.added < 1) {
    log.warn('copium album add: nothing was added', { status: res.status, added: json.added ?? null })
    return false
  }
  return true
}
