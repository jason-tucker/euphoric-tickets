import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { ExportReturnType, generateFromMessages } from 'discord-html-transcripts'
import { buildProfiles, buildReplyAvatars, renderDiscordTranscriptHtml } from '../src/services/transcriptService'
import {
  COMPONENTS_CORE_VERSION,
  LIBRARY_COMPONENTS_SRC,
  PINNED_COMPONENTS_SRC,
  TRANSCRIPT_CSP,
  findTranscriptViolations,
  isDangerousUrlValue,
  sanitizeTranscriptHtml,
} from '../src/services/transcriptSanitizer'
import {
  HOSTILE_AVATAR_HASH,
  HOSTILE_CONTENT,
  HOSTILE_NAMES,
  HOSTILE_ROLE_NAME,
  hostileConversation,
} from './fixtures/hostileConversation'
import { sampleConversation } from './fixtures/sampleConversation'

type Element = DefaultTreeAdapterTypes.Element
type ParentNode = DefaultTreeAdapterTypes.ParentNode

afterEach(() => {
  vi.restoreAllMocks()
})

// Independent of the sanitizer's own checker: parse like a browser and
// collect every element (template contents included) and text node.
function inspect(html: string) {
  const elements: Element[] = []
  const texts: string[] = []
  const visit = (node: ParentNode) => {
    for (const child of node.childNodes) {
      if (child.nodeName === '#text') texts.push((child as DefaultTreeAdapterTypes.TextNode).value)
      if (!('tagName' in child)) continue
      elements.push(child)
      visit(child)
      if ('content' in child) visit((child as DefaultTreeAdapterTypes.Template).content)
    }
  }
  visit(parse(html))
  const get = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value
  return { elements, texts, get, byTag: (tag: string) => elements.filter((e) => e.tagName.toLowerCase() === tag) }
}

const TEXT_ATTRS = new Set(['author', 'alt', 'title', 'aria-label'])

function expectSafe(html: string, scriptSrc: string) {
  const d = inspect(html)
  const scripts = d.byTag('script')
  expect(scripts).toHaveLength(1)
  expect(scripts[0].attrs).toEqual([
    { name: 'type', value: 'module' },
    { name: 'src', value: scriptSrc },
  ])
  expect(scripts[0].childNodes).toHaveLength(0)
  for (const el of d.elements) {
    for (const a of el.attrs) {
      expect(a.name.toLowerCase().startsWith('on'), `${a.name} on <${el.tagName}>`).toBe(false)
      expect(a.name.toLowerCase()).not.toBe('srcdoc')
      if (!TEXT_ATTRS.has(a.name)) expect(a.value.replace(/[\s\u0000-\u001f]/g, '')).not.toMatch(/^(javascript|vbscript):/i)
    }
    expect(['iframe', 'object', 'embed', 'base', 'template', 'noscript', 'form', 'math']).not.toContain(el.tagName.toLowerCase())
    if (el.tagName === 'meta' && d.get(el, 'http-equiv')) expect(d.get(el, 'http-equiv')).toBe('Content-Security-Policy')
  }
  const charsets = d.byTag('meta').filter((m) => d.get(m, 'charset') !== undefined)
  expect(charsets.map((m) => d.get(m, 'charset'))).toEqual(['utf-8'])
  // String level: the only literal "<script" (any case) is the components one.
  expect(html.match(/<script/gi)).toHaveLength(1)
  return d
}

const headWith = (inner: string, body = '<discord-messages><discord-message id="m-1" profile="1">hi</discord-message></discord-messages>') =>
  `<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>t</title>${inner}` +
  `<script type="module" src="${LIBRARY_COMPONENTS_SRC}"></script></head><body>${body}</body></html>`
const profiles = new Map([['1', { author: 'Alice', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png', bot: false, verified: false, roleColor: undefined }]])
// The library's vulnerable shape: a raw JSON.stringify inside an inline script.
const profileScript = (name: string) => `<script>window.$discordMessage={profiles:${JSON.stringify({ '1': { author: name } })}}</script>`

describe('transcript sanitizer — script injection via profile data (regression)', () => {
  it('raw library output really is exploitable: a display name closes the profiles script', async () => {
    const { client, channel, messages } = hostileConversation()
    try {
      const raw = await generateFromMessages(messages, channel, { returnType: ExportReturnType.String, saveImages: false, poweredBy: false })
      // The finding: browser tokenization yields a participant-controlled script.
      const scripts = inspect(raw).byTag('script')
      expect(scripts.some((s) => s.childNodes.some((t) => 'value' in t && t.value.startsWith('alert(1)//')))).toBe(true)
      // And the library emits the components src the upload keeps.
      expect(raw).toContain(`<script type="module" src="${LIBRARY_COMPONENTS_SRC}"></script>`)
    } finally {
      await client.destroy()
    }
  })

  it('parser control alone (raw library output straight into the sanitizer): one allowed script, no handlers', async () => {
    const { client, channel, messages } = hostileConversation()
    try {
      const raw = await generateFromMessages(messages, channel, { returnType: ExportReturnType.String, saveImages: false, poweredBy: false })
      const out = sanitizeTranscriptHtml(raw, { profiles: buildProfiles(messages), replyAvatars: buildReplyAvatars(messages) })
      expectSafe(out.upload, LIBRARY_COMPONENTS_SRC)
      expectSafe(out.attachment, PINNED_COMPONENTS_SRC)
      expect(findTranscriptViolations(out.attachment, { scriptSrc: PINNED_COMPONENTS_SRC, csp: true })).toEqual([])
    } finally {
      await client.destroy()
    }
  })

  it('when a hostile name swallows the document, the completeness check throws (caller falls back to the legacy HTML)', async () => {
    const { client, channel, messages } = hostileConversation()
    try {
      const raw = await generateFromMessages(messages, channel, { returnType: ExportReturnType.String, saveImages: false, poweredBy: false })
      // `<!--<script>` puts the tokenizer in "script data double escaped": the
      // rest of the document becomes script text, which is dropped.
      expect(() =>
        sanitizeTranscriptHtml(raw, {
          profiles: buildProfiles(messages),
          requiredIds: messages.filter((m) => !m.system).map((m) => `m-${m.id}`),
        }),
      ).toThrow(/expected element\(s\) missing/)
    } finally {
      await client.destroy()
    }
  })

  it('full render: hostile names/role/avatar/webhook stay inert attribute values; every message survives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, channel, messages } = hostileConversation()
    try {
      const out = await renderDiscordTranscriptHtml({ channel, messages, ticketId: 9, filename: 'ticket-9-hostile.html' })
      // The profiles script was cut out verbatim before parsing.
      expect(warn).not.toHaveBeenCalled()
      for (const [html, src] of [
        [out.upload, LIBRARY_COMPONENTS_SRC],
        [out.attachment, PINNED_COMPONENTS_SRC],
      ] as const) {
        const d = expectSafe(html, src)
        expect(html).not.toContain('$discordMessage')
        expect(html).not.toContain('profile=')
        // No hostile string leaked into a text node (e.g. leftover JSON).
        for (const t of d.texts) {
          for (const name of [...Object.values(HOSTILE_NAMES), HOSTILE_ROLE_NAME]) expect(t).not.toContain(name)
        }
        const msgs = d.byTag('discord-message')
        expect(msgs).toHaveLength(messages.length)
        for (const m of messages) expect(msgs.some((e) => d.get(e, 'id') === `m-${m.id}`)).toBe(true)
        // Exact, correctly escaped round trip of each name into author="…".
        const authors = new Set(msgs.map((e) => d.get(e, 'author')))
        for (const name of Object.values(HOSTILE_NAMES)) expect(authors).toContain(name)
        // `<` / `>` are entity-escaped inside attribute values too.
        expect(html).toContain('author="&lt;/script&gt;&lt;script&gt;alert(1)//"')
        expect(html).toContain('author="&quot; onmouseover=&quot;alert(5)"')
        // The avatar built from a hostile hash is still one URL attribute.
        const evilAvatar = msgs.map((e) => d.get(e, 'avatar')!).find((a) => a.includes('/avatars/400000000000000104/'))!
        expect(evilAvatar.startsWith('https://cdn.discordapp.com/avatars/400000000000000104/')).toBe(true)
        expect(decodeURIComponent(evilAvatar)).toContain(HOSTILE_AVATAR_HASH)
        // Content that looks like markup stays text.
        const allText = d.texts.join('\n')
        expect(allText).toContain(HOSTILE_CONTENT[0])
        expect(allText).toContain(HOSTILE_CONTENT[1])
        expect(d.byTag('img').every((e) => !d.get(e, 'onerror'))).toBe(true)
        expect(d.byTag('a').every((e) => !/javascript:/i.test(d.get(e, 'href') ?? ''))).toBe(true)
      }
    } finally {
      await client.destroy()
    }
  })
})

describe('sanitizeTranscriptHtml — breakout variants and active content', () => {
  const variants = [
    '</script><script>alert(1)//',
    '</SCRIPT ><script>alert(2)//',
    '</ScRiPt\n><script >alert(2)</script >',
    '</script ><img src=x onerror=alert(4)>',
    '</script><svg><script>alert(5)</script><a href="javascript:alert(6)">x</a></svg>',
    '</script><svg><animate onbegin=alert(7) attributeName=x dur=1s>',
    '</script><math><mi><mglyph><style><img src=x onerror=alert(8)>',
    '</script><svg><foreignObject><style></style><img src=x onerror=alert(9)></foreignObject></svg>',
    '</script><iframe srcdoc="<script>alert(10)</script>"></iframe>',
    '</script><object data="javascript:alert(11)"></object><embed src="x.swf">',
    '</script><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">',
    '</script><template><script>alert(12)</script></template>',
    '</script><noscript><img src=x onerror=alert(13)></noscript>',
    '</script><a href="jav&#x09;ascript:alert(14)">x</a><a href=" JAVASCRIPT:alert(15)">y</a>',
    '</script><form action="https://evil.example"><input name=p><button formaction="javascript:alert(16)">go</button></form>',
    '</script><link rel="stylesheet" href="https://evil.example/x.css"><link rel="import" href="x">',
    '</script><script src="https://cdn.jsdelivr.net/npm/evil-pkg/x.js"></script>',
    `</script><script type="module" src="${PINNED_COMPONENTS_SRC}" onload="alert(17)"></script>`,
    '</script><div onclick="alert(18)" style="position:fixed">x</div><p onmouseover=alert(19)>y</p>',
    '</script><a href="data:text/html,<script>alert(20)</script>">d</a><img src="data:image/png;base64,AAAA">',
    '"}}</script><xmp><script>alert(21)</script></xmp><textarea><script>alert(22)</script></textarea>',
    '</script><meta charset="ISO-2022-JP"><meta http-equiv="set-cookie" content="a=b">',
    `A "q" <b> & 'x'`,
  ]

  // Unclosed foreign content swallows the rest of the document (MathML text
  // integration points keep HTML children inside <math>, which is dropped):
  // script-safe either way, and the completeness check fails it closed.
  const SWALLOWS = new Set(['</script><math><mi><mglyph><style><img src=x onerror=alert(8)>'])

  for (const name of variants) {
    it(`neutralizes ${JSON.stringify(name)}`, () => {
      const html = headWith(profileScript(name))
      if (SWALLOWS.has(name)) {
        expect(() => sanitizeTranscriptHtml(html, { profiles, requiredIds: ['m-1'] })).toThrow(/expected element\(s\) missing/)
        const { attachment } = sanitizeTranscriptHtml(html, { profiles })
        expectSafe(attachment, PINNED_COMPONENTS_SRC)
        return
      }
      const out = sanitizeTranscriptHtml(html, { profiles, requiredIds: ['m-1'] })
      for (const [html, src] of [
        [out.upload, LIBRARY_COMPONENTS_SRC],
        [out.attachment, PINNED_COMPONENTS_SRC],
      ] as const) {
        const d = expectSafe(html, src)
        expect(d.byTag('link').every((l) => d.get(l, 'rel') === 'icon')).toBe(true)
        // Profile rewrite still works on the real element.
        const msg = d.byTag('discord-message').find((e) => d.get(e, 'id') === 'm-1')!
        expect(d.get(msg, 'author')).toBe('Alice')
        expect(d.get(msg, 'profile')).toBeUndefined()
      }
    })
  }

  it('keeps data:image rasters, drops other data: URLs and unwraps unknown HTML elements keeping their text', () => {
    const body =
      '<discord-messages><discord-message id="m-1" profile="1"><table><tr><td>cell text</td></tr></table>' +
      '<img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml,<svg onload=alert(1)>">' +
      '<custom-thing>kept</custom-thing><!-- a comment --></discord-message></discord-messages>'
    const { attachment } = sanitizeTranscriptHtml(headWith('', body), { profiles })
    const d = expectSafe(attachment, PINNED_COMPONENTS_SRC)
    const imgs = d.byTag('img')
    expect(imgs.map((i) => d.get(i, 'src'))).toEqual(['data:image/png;base64,AAAA', undefined])
    expect(d.byTag('table')).toHaveLength(0)
    expect(d.byTag('custom-thing')).toHaveLength(0)
    expect(d.texts.join('')).toContain('cell text')
    expect(d.texts.join('')).toContain('kept')
    expect(attachment).not.toContain('<!--')
  })

  it('fills an empty <discord-reply> avatar from the referenced message; leaves unresolvable replies alone', () => {
    const body =
      '<discord-messages><discord-message id="m-1" profile="1"><discord-reply slot="reply" author="Bob"><span data-goto="42">x</span></discord-reply>' +
      '<discord-reply slot="reply" author="Carol" avatar="https://cdn.discordapp.com/avatars/1/keep.png"><span data-goto="42">y</span></discord-reply>' +
      '<discord-reply slot="reply">Message could not be loaded.</discord-reply>' +
      '<discord-reply slot="reply" author="Dan"><em data-goto="43">z</em></discord-reply></discord-message></discord-messages>'
    const replyAvatars = new Map([
      ['42', 'https://cdn.discordapp.com/embed/avatars/3.png'],
      ['43', 'javascript:alert(1)'],
    ])
    const { upload } = sanitizeTranscriptHtml(headWith('', body), { profiles, replyAvatars })
    const d = inspect(upload)
    expect(d.byTag('discord-reply').map((r) => d.get(r, 'avatar'))).toEqual([
      'https://cdn.discordapp.com/embed/avatars/3.png',
      'https://cdn.discordapp.com/avatars/1/keep.png',
      undefined,
      undefined,
    ])
  })

  it('the attachment carries the CSP meta right after the charset, before any script; the upload has none', () => {
    const { upload, attachment } = sanitizeTranscriptHtml(headWith(''), { profiles })
    expect(upload).not.toContain('http-equiv')
    expect(attachment).toContain(
      `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${TRANSCRIPT_CSP}">`,
    )
    expect(attachment.indexOf('Content-Security-Policy')).toBeLessThan(attachment.indexOf('<script'))
  })

  it('a name that swallows the rest of the document into a script fails closed instead of emitting an empty transcript', () => {
    expect(() => sanitizeTranscriptHtml(headWith(profileScript('<!--<script>alert(3)//')), { profiles, requiredIds: ['m-1'] })).toThrow(
      /expected element\(s\) missing/,
    )
    // Even without the completeness check the result is script-safe.
    const { attachment } = sanitizeTranscriptHtml(headWith(profileScript('<!--<script>alert(3)//')), { profiles })
    expectSafe(attachment, PINNED_COMPONENTS_SRC)
  })

  it('findTranscriptViolations flags every broken invariant', () => {
    const bad = `<!DOCTYPE html><html><head><script>alert(1)</script><script type="module" src="${PINNED_COMPONENTS_SRC}"></script></head><body><div onclick="x" id="a"><a href="javascript:x">l</a></div></body></html>`
    const v = findTranscriptViolations(bad, { scriptSrc: PINNED_COMPONENTS_SRC, csp: true, requiredIds: ['a', 'missing'] })
    expect(v).toEqual(
      expect.arrayContaining([
        'onclick attribute on <div>',
        'dangerous URL in href on <a>',
        '1 expected element(s) missing',
        '2 script elements',
        'unexpected script element',
        '2 literal <script occurrences',
        'missing or misplaced CSP meta',
      ]),
    )
  })

  it('isDangerousUrlValue sees through whitespace/control obfuscation', () => {
    for (const v of ['javascript:x', ' JaVaScRiPt:x', 'java\tscript:x', 'java\nscript:x', '\u0001javascript:x', 'vbscript:x', 'data:text/html,x', 'data:image/svg+xml,x']) {
      expect(isDangerousUrlValue(v), v).toBe(true)
    }
    for (const v of ['https://cdn.discordapp.com/a.png', '#m-1', 'data:image/png;base64,AA', 'mailto:a@b.c', '/relative']) {
      expect(isDangerousUrlValue(v), v).toBe(false)
    }
  })
})

describe('components script pin', () => {
  it('COMPONENTS_CORE_VERSION is the @derockdev/discord-components-core installed for discord-html-transcripts', () => {
    const req = createRequire(createRequire(import.meta.url).resolve('discord-html-transcripts'))
    let dir = dirname(req.resolve('@derockdev/discord-components-core'))
    while (!readFileSafe(join(dir, 'package.json'))?.includes('"name": "@derockdev/discord-components-core"')) {
      expect(dirname(dir)).not.toBe(dir)
      dir = dirname(dir)
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
    expect(pkg.version).toBe(COMPONENTS_CORE_VERSION)
    expect(PINNED_COMPONENTS_SRC).toBe(
      `https://cdn.jsdelivr.net/npm/@derockdev/discord-components-core@${COMPONENTS_CORE_VERSION}/dist/derockdev-discord-components-core/derockdev-discord-components-core.esm.js`,
    )
    expect(TRANSCRIPT_CSP).not.toContain('unsafe-inline')
    expect(TRANSCRIPT_CSP).not.toContain('unsafe-eval')
    expect(TRANSCRIPT_CSP).toContain(`script-src https://cdn.jsdelivr.net/npm/@derockdev/discord-components-core@${COMPONENTS_CORE_VERSION}/dist/derockdev-discord-components-core/;`)
    expect(TRANSCRIPT_CSP).toContain("object-src 'none'")
    expect(TRANSCRIPT_CSP).toContain("base-uri 'none'")
  })

  it('the benign sample renders with a reply avatar filled from the referenced author', async () => {
    const { client, channel, messages } = sampleConversation()
    try {
      const { attachment } = await renderDiscordTranscriptHtml({ channel, messages, ticketId: 7, filename: 'x.html' })
      const d = expectSafe(attachment, PINNED_COMPONENTS_SRC)
      const reply = d.byTag('discord-reply')[0]
      expect(d.get(reply, 'avatar')).toBe(messages[1].author.displayAvatarURL({ size: 32 }))
    } finally {
      await client.destroy()
    }
  })
})

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
