import { defaultTreeAdapter, html as html5, parse, serialize, type DefaultTreeAdapterTypes } from 'parse5'

// TRUST BOUNDARY for every Discord-style transcript HTML the bot emits (the
// copium.pics upload and the opener's DM attachment, which they open locally
// in a browser).
//
// discord-html-transcripts writes participant profile data (nicknames,
// display names, role names, avatar URLs) into an inline
// `<script>window.$discordMessage={profiles:…}</script>` with a raw
// JSON.stringify, so a name like `</script><script>alert(1)//` closes the
// script and injects markup. Message content itself is escaped by the
// library; the profile script is the known vector, but this sanitizer does
// not rely on that: it parses the whole document with parse5 (a WHATWG
// spec-compliant parser — it tokenizes exactly like a browser, so a
// broken-out `<script>` is its own element here too), rebuilds it from an
// allowlist and re-parses its own output to prove the invariants before
// anything is returned. Any violation throws, and the caller falls back to
// the legacy, fully escaped renderer.
//
// Invariants of the output (checked by findTranscriptViolations):
//  - exactly one <script>, ours: `<script type="module" src="<components>">`
//    with no content — every other script (inline, other src, SVG script) is
//    removed, whatever its position;
//  - no inline event-handler attribute (on*) and no srcdoc/formaction/action;
//  - no javascript:/vbscript:/data: (non-raster-image) URL in any attribute;
//  - no iframe/object/embed/base/form/template/noscript/… element; <meta>
//    only our leading `charset="utf-8"` and viewport (plus our CSP on the
//    attachment), <link> only rel="icon";
//  - the attachment variant carries TRANSCRIPT_CSP as a <meta> before the script.

type Node = DefaultTreeAdapterTypes.Node
type ParentNode = DefaultTreeAdapterTypes.ParentNode
type ChildNode = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element
type Document = DefaultTreeAdapterTypes.Document

export type TranscriptProfile = {
  author: string
  avatar: string
  bot: boolean
  verified: boolean
  roleColor: string | undefined
}

// @derockdev/discord-components-core renders the <discord-*> elements in a
// browser. discord-html-transcripts 3.3.0 emits its src with its own semver
// range; the upload keeps that exact URL (copium swaps it for its vendored
// copy and may match on it), the local attachment is pinned to the version
// installed alongside the library (test/transcriptSanitizer.test.ts checks
// that this constant matches node_modules).
export const COMPONENTS_CORE_VERSION = '3.6.1'
const COMPONENTS_DIR = (version: string) =>
  `https://cdn.jsdelivr.net/npm/@derockdev/discord-components-core@${version}/dist/derockdev-discord-components-core/`
const COMPONENTS_ENTRY = 'derockdev-discord-components-core.esm.js'
export const LIBRARY_COMPONENTS_SRC = COMPONENTS_DIR('^3.6.1') + COMPONENTS_ENTRY
export const PINNED_COMPONENTS_SRC = COMPONENTS_DIR(COMPONENTS_CORE_VERSION) + COMPONENTS_ENTRY

// CSP for the local attachment only. script-src is the pinned package
// directory (the entry module lazy-loads its p-*.js chunks from there); no
// 'unsafe-inline', so inline scripts, on* handlers and javascript: URLs are
// refused even if something slipped past the sanitizer. Styles, fonts and
// images are left open: the library emits inline <style>/style="" and the
// components load Discord CDN avatars, twemoji and a web font.
// Not added to the copium upload: copium serves its own CSP header and swaps
// the script for its vendored copy on transcripts.copium.tools, which a
// jsDelivr-only meta policy would block (a meta CSP and a header CSP both apply).
export const TRANSCRIPT_CSP = [
  `script-src ${COMPONENTS_DIR(COMPONENTS_CORE_VERSION)}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

const NS = html5.NS

// Removed with everything inside them.
const DROP_ELEMENTS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'basefont',
  'noscript', 'noembed', 'noframes', 'template', 'form', 'portal', 'fencedframe', 'xmp',
  'plaintext', 'textarea', 'input', 'button', 'select', 'option', 'isindex', 'param',
])
// Kept (HTML namespace). The library's own light DOM uses html/head/body,
// meta/link/title/script/style, div/span/a/br/em/i/s/img and svg/path plus the
// <discord-*> custom elements; the rest are harmless text formatting. Any
// other HTML element is unwrapped: the element goes, its (sanitized) children
// stay. Any other SVG/MathML element is dropped with its content, because
// moving children out of foreign content (e.g. out of <foreignObject>) could
// change how they re-parse.
const HTML_ELEMENTS = new Set([
  'html', 'head', 'body', 'meta', 'link', 'title', 'style',
  'div', 'span', 'a', 'br', 'em', 'i', 'b', 's', 'u', 'strong', 'small', 'img', 'p',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'sub', 'sup', 'del', 'ins', 'mark', 'time',
])
const SVG_ELEMENTS = new Set(['svg', 'path'])
const CUSTOM_ELEMENT = /^discord-[a-z0-9-]+$/

const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'ping', 'nonce', 'http-equiv'])
// Plain-text attributes never used as URLs (an author literally named
// "javascript:x" keeps its name).
const TEXT_ATTRS = new Set(['author', 'alt', 'title', 'aria-label'])

// URL parsers ignore ASCII whitespace/controls inside a scheme ("java\tscript:").
export function isDangerousUrlValue(value: string): boolean {
  const v = value.replace(/[\x00-\x20\x7f-\x9f]/g, '').toLowerCase()
  if (/^(?:javascript|vbscript|livescript):/.test(v)) return true
  if (v.startsWith('data:')) return !/^data:image\/(?:png|gif|jpeg|jpg|webp|avif)[;,]/.test(v)
  return false
}

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name && !a.prefix)
function setAttr(el: Element, name: string, value: string): void {
  const a = attr(el, name)
  if (a) a.value = value
  else el.attrs.push({ name, value })
}
const isElement = (n: Node): n is Element => 'tagName' in n
const detach = (n: ChildNode) => defaultTreeAdapter.detachNode(n)

type Context = {
  profiles: Map<string, TranscriptProfile>
  replyAvatars: Map<string, string>
}

// Discord's "no colour" — black text on the dark theme; leave it to the default.
const NO_ROLE_COLOR = '#000000'

function classify(el: Element): 'keep' | 'drop' | 'unwrap' {
  const tag = el.tagName.toLowerCase()
  if (DROP_ELEMENTS.has(tag)) return 'drop'
  if (el.namespaceURI === NS.HTML) {
    if (tag === 'meta') {
      // Only viewport is kept; every charset declaration is dropped and ours
      // (utf-8) is inserted first, so injected markup cannot switch the
      // decoder (e.g. ISO-2022-JP tricks) or add refresh/CSP/cookie metas.
      const names = el.attrs.map((a) => a.name)
      const viewport = attr(el, 'name')?.value.toLowerCase() === 'viewport' && names.every((n) => n === 'name' || n === 'content')
      return viewport ? 'keep' : 'drop'
    }
    if (tag === 'link') {
      const rel = attr(el, 'rel')?.value.trim().toLowerCase()
      const ok = rel === 'icon' && el.attrs.every((a) => ['rel', 'type', 'href', 'sizes'].includes(a.name))
      return ok ? 'keep' : 'drop'
    }
    return HTML_ELEMENTS.has(tag) || CUSTOM_ELEMENT.test(tag) ? 'keep' : 'unwrap'
  }
  if (el.namespaceURI === NS.SVG) return SVG_ELEMENTS.has(tag) ? 'keep' : 'drop'
  return 'drop' // MathML and anything else
}

function rewriteProfile(el: Element, ctx: Context): void {
  // <discord-message profile="…">, <discord-command …>, <discord-thread-message …>:
  // copium strips the library's inline profiles map, so the author/avatar are
  // made explicit attributes (escaped by the serializer).
  const profile = attr(el, 'profile')
  if (profile) {
    el.attrs = el.attrs.filter((a) => a !== profile)
    const p = ctx.profiles.get(profile.value)
    if (p) {
      setAttr(el, 'author', p.author)
      setAttr(el, 'avatar', p.avatar)
      if (p.bot) setAttr(el, 'bot', '')
      if (p.verified) setAttr(el, 'verified', '')
      if (p.roleColor && p.roleColor.toLowerCase() !== NO_ROLE_COLOR) setAttr(el, 'role-color', p.roleColor)
    }
  }
  const roleColor = attr(el, 'role-color')
  if (roleColor && roleColor.value.trim().toLowerCase() === NO_ROLE_COLOR) el.attrs = el.attrs.filter((a) => a !== roleColor)
}

function sanitizeAttributes(el: Element): void {
  el.attrs = el.attrs.filter((a) => {
    const name = a.name.toLowerCase()
    if (name.startsWith('on')) return false
    if (DROP_ATTRS.has(name)) return false
    if (!TEXT_ATTRS.has(name) && isDangerousUrlValue(a.value)) return false
    return true
  })
}

function findGotoId(el: Element): string | undefined {
  for (const child of el.childNodes) {
    if (!isElement(child)) continue
    const goto = attr(child, 'data-goto')?.value
    if (goto) return goto
    const nested = findGotoId(child)
    if (nested) return nested
  }
  return undefined
}

function sanitizeChildren(parent: ParentNode, ctx: Context): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeName === '#comment') {
      detach(node)
      continue
    }
    if (node.nodeName === '#documentType') {
      if (parent.nodeName !== '#document') detach(node)
      continue
    }
    if (!isElement(node)) continue // text: the serializer escapes it
    const decision = classify(node)
    if (decision === 'drop') {
      detach(node)
      continue
    }
    rewriteProfile(node, ctx)
    sanitizeAttributes(node)
    sanitizeChildren(node, ctx)
    const tag = node.tagName.toLowerCase()
    if (tag === 'discord-reply' && !attr(node, 'avatar')?.value) {
      // The library leaves a reply's avatar empty when the replied-to user has
      // no custom avatar; fill it from the referenced message's author.
      const goto = findGotoId(node)
      const avatar = goto ? ctx.replyAvatars.get(goto) : undefined
      if (avatar && !isDangerousUrlValue(avatar)) setAttr(node, 'avatar', avatar)
    }
    if (tag === 'style') {
      // Stray text node the library emits after its inline <style> (a visible ";").
      const siblings = node.parentNode?.childNodes ?? []
      const next = siblings[siblings.indexOf(node) + 1]
      if (next && next.nodeName === '#text') {
        const text = next as DefaultTreeAdapterTypes.TextNode
        if (text.value.startsWith(';')) {
          text.value = text.value.slice(1)
          if (!text.value) detach(text)
        }
      }
    }
    if (decision === 'unwrap') {
      for (const child of [...node.childNodes]) {
        detach(child)
        defaultTreeAdapter.insertBefore(parent, child, node)
      }
      detach(node)
    }
  }
}

function childElement(parent: ParentNode, tag: string): Element | undefined {
  return parent.childNodes.find((n): n is Element => isElement(n) && n.tagName === tag && n.namespaceURI === NS.HTML)
}

// parse5 serializes attribute values with only `&`, `"` and NBSP escaped (the
// spec minimum), so a name like `</script><script>` would sit literally inside
// a quoted attribute. Harmless to a browser, but a regex-based consumer (e.g.
// a host's own script stripper) could mis-tokenize it, so `<` and `>` in
// attribute values are written as &lt; / &gt; too (identical DOM on re-parse).
// They are swapped for two private-use sentinels before serializing and back
// after; the input and every attribute value are cleared of those code points
// first (to U+FFFD), so only the escaping can produce them.
const LT = '\uE000'
const GT = '\uE001'
const SENTINELS = /[\uE000\uE001]/g
const escapingAdapter: typeof defaultTreeAdapter = {
  ...defaultTreeAdapter,
  getAttrList: (el) =>
    defaultTreeAdapter.getAttrList(el).map((a) => ({ ...a, value: a.value.replace(SENTINELS, '\uFFFD').replace(/</g, LT).replace(/>/g, GT) })),
}
function serializeDocument(doc: Document): string {
  return serialize(doc, { treeAdapter: escapingAdapter }).replace(/\uE000/g, '&lt;').replace(/\uE001/g, '&gt;')
}

export type SanitizedTranscript = { upload: string; attachment: string }

// Returns the two variants: `upload` (copium: no CSP meta, the library's
// components src) and `attachment` (local DM file: CSP meta, pinned src).
export function sanitizeTranscriptHtml(
  input: string,
  opts: {
    profiles: Map<string, TranscriptProfile>
    replyAvatars?: Map<string, string>
    // Element ids that must survive (e.g. `m-<messageId>` per non-system
    // message). A hostile string can make the parser swallow the rest of the
    // document into a script — safe, since that script is dropped, but the
    // transcript would be silently empty — so a missing id throws instead and
    // the caller uses the legacy renderer, which keeps every message.
    requiredIds?: string[]
  },
): SanitizedTranscript {
  const doc = parse(input.replace(SENTINELS, '\uFFFD'))
  sanitizeChildren(doc, { profiles: opts.profiles, replyAvatars: opts.replyAvatars ?? new Map() })

  const htmlEl = childElement(doc, 'html')
  const head = htmlEl && childElement(htmlEl, 'head')
  if (!head) throw new Error('transcript sanitizer: document has no <head>')
  const charset = defaultTreeAdapter.createElement('meta', NS.HTML, [{ name: 'charset', value: 'utf-8' }])
  if (head.childNodes[0]) defaultTreeAdapter.insertBefore(head, charset, head.childNodes[0])
  else defaultTreeAdapter.appendChild(head, charset)
  const script = defaultTreeAdapter.createElement('script', NS.HTML, [
    { name: 'type', value: 'module' },
    { name: 'src', value: LIBRARY_COMPONENTS_SRC },
  ])
  defaultTreeAdapter.appendChild(head, script)
  const upload = serializeDocument(doc)

  attr(script, 'src')!.value = PINNED_COMPONENTS_SRC
  const csp = defaultTreeAdapter.createElement('meta', NS.HTML, [
    { name: 'http-equiv', value: 'Content-Security-Policy' },
    { name: 'content', value: TRANSCRIPT_CSP },
  ])
  // Right after our charset declaration, so it precedes every resource the
  // document loads (head always holds at least the charset and the script).
  defaultTreeAdapter.insertBefore(head, csp, head.childNodes[1])
  const attachment = serializeDocument(doc)

  // Prove the invariants on what a browser will actually parse.
  const requiredIds = opts.requiredIds ?? []
  const uploadViolations = findTranscriptViolations(upload, { scriptSrc: LIBRARY_COMPONENTS_SRC, csp: false, requiredIds })
  const attachmentViolations = findTranscriptViolations(attachment, { scriptSrc: PINNED_COMPONENTS_SRC, csp: true, requiredIds })
  if (uploadViolations.length || attachmentViolations.length) {
    throw new Error(
      `transcript sanitizer: output failed verification (${[...uploadViolations, ...attachmentViolations].slice(0, 5).join('; ')})`,
    )
  }
  return { upload, attachment }
}

function walk(node: ParentNode, visit: (el: Element) => void): void {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue
    visit(child)
    walk(child, visit)
    if (child.tagName === 'template' && 'content' in child) walk((child as DefaultTreeAdapterTypes.Template).content, visit)
  }
}

// Re-parses `html` like a browser and lists every invariant it breaks
// (empty = safe). Exported for the tests.
export function findTranscriptViolations(
  html: string,
  expect: { scriptSrc: string; csp: boolean; requiredIds?: string[] },
): string[] {
  const doc: Document = parse(html)
  const out: string[] = []
  const scripts: Element[] = []
  const cspMetas: Element[] = []
  let order = 0
  let cspOrder = -1
  let scriptOrder = -1
  const ids = new Set<string>()
  const charsets: Element[] = []
  walk(doc, (el) => {
    order++
    const id = attr(el, 'id')?.value
    if (id) ids.add(id)
    const tag = el.tagName.toLowerCase()
    if (tag === 'script') {
      scripts.push(el)
      scriptOrder = order
    }
    if (DROP_ELEMENTS.has(tag) && tag !== 'script') out.push(`<${tag}> element`)
    if (tag === 'meta' && attr(el, 'charset')) charsets.push(el)
    if (tag === 'meta' && attr(el, 'http-equiv')) {
      cspMetas.push(el)
      cspOrder = order
    }
    for (const a of el.attrs) {
      const name = a.name.toLowerCase()
      if (name.startsWith('on')) out.push(`${name} attribute on <${tag}>`)
      if (DROP_ATTRS.has(name) && !(tag === 'meta' && name === 'http-equiv')) out.push(`${name} attribute on <${tag}>`)
      if (!TEXT_ATTRS.has(name) && isDangerousUrlValue(a.value)) out.push(`dangerous URL in ${name} on <${tag}>`)
    }
  })
  const c = charsets[0]
  const head = c?.parentNode
  if (charsets.length !== 1 || attr(c, 'charset')?.value !== 'utf-8' || head?.nodeName !== 'head' || head.childNodes[0] !== c) {
    out.push('charset meta is not the single leading utf-8 declaration')
  }
  const missing = (expect.requiredIds ?? []).filter((id) => !ids.has(id))
  if (missing.length) out.push(`${missing.length} expected element(s) missing`)
  if (scripts.length !== 1) out.push(`${scripts.length} script elements`)
  // String level too, for consumers that scan rather than parse: the only
  // literal `<script` is ours (attribute values and text are entity-escaped).
  const literal = html.match(/<script/gi)?.length ?? 0
  if (literal !== 1) out.push(`${literal} literal <script occurrences`)
  for (const s of scripts) {
    const ok =
      s.namespaceURI === NS.HTML &&
      s.attrs.length === 2 &&
      attr(s, 'type')?.value === 'module' &&
      attr(s, 'src')?.value === expect.scriptSrc &&
      s.childNodes.length === 0
    if (!ok) out.push('unexpected script element')
  }
  if (expect.csp) {
    const m = cspMetas[0]
    const ok =
      cspMetas.length === 1 &&
      m.attrs.length === 2 &&
      attr(m, 'http-equiv')?.value === 'Content-Security-Policy' &&
      attr(m, 'content')?.value === TRANSCRIPT_CSP &&
      m.parentNode?.nodeName === 'head' &&
      cspOrder < scriptOrder
    if (!ok) out.push('missing or misplaced CSP meta')
  } else if (cspMetas.length) {
    out.push('unexpected http-equiv meta')
  }
  return out
}
