// Minimal discord.js stand-ins: just the surface the ticket code touches.
import { randomUUID } from 'node:crypto'
import { ChannelType, Collection } from 'discord.js'
import { db } from '../src/db/client'
import { businesses, ticketCategories, type Business, type TicketCategory } from '../src/db/schema'

let seq = BigInt(Date.now()) * 1000n
export const snow = (): string => String(100000000000000000n + (seq++ % 800000000000000000n))

export const BOT_ID = '100000000000000009'

export type Sent = { content?: string; components?: { toJSON(): unknown }[]; [k: string]: unknown }

type Json = { type?: number; url?: string; content?: string; components?: Json[]; accessory?: Json }

function walk(c: Json, f: (c: Json) => void): void {
  f(c)
  for (const x of c.components ?? []) walk(x, f)
  if (c.accessory) walk(c.accessory, f)
}

// Discord's documented message limits that the ticket code can hit: a link
// button URL is at most 512 chars, and a Components V2 message carries at most
// 4000 chars of text across ALL its Text Displays. Violations throw the same
// 50035 Invalid Form Body that the real API returns.
export function assertDiscordLimits(payload: Sent): void {
  let text = 0
  for (const top of payload.components ?? []) {
    const json = (typeof top.toJSON === 'function' ? top.toJSON() : top) as Json
    walk(json, (c) => {
      if (c.type === 2 && typeof c.url === 'string' && c.url.length > 512) {
        throw Object.assign(new Error('Invalid Form Body: url must be 512 or fewer in length'), { code: 50035 })
      }
      if (c.type === 10 && typeof c.content === 'string') text += c.content.length
    })
  }
  if (text > 4000) throw Object.assign(new Error(`Invalid Form Body: total text ${text} > 4000`), { code: 50035 })
}

// All Text Display contents of a sent payload, in order.
export function textDisplays(payload: Sent | undefined): string[] {
  const out: string[] = []
  for (const top of payload?.components ?? []) {
    walk((typeof top.toJSON === 'function' ? top.toJSON() : top) as Json, (c) => {
      if (c.type === 10 && typeof c.content === 'string') out.push(c.content)
    })
  }
  return out
}

export class FakeWebhook {
  deleted = false
  owner = { id: BOT_ID }
  constructor(
    public id: string,
    public name: string,
    public token: string | null,
    private hooks: FakeWebhook[],
  ) {}
  get url(): string {
    return `https://discord.com/api/webhooks/${this.id}/${this.token}`
  }
  async delete(): Promise<void> {
    this.deleted = true
    const i = this.hooks.indexOf(this)
    if (i >= 0) this.hooks.splice(i, 1)
  }
}

export class FakeTextChannel {
  type = ChannelType.GuildText
  sent: Sent[] = []
  webhooks: FakeWebhook[] = []
  deleted = false
  client = { user: { id: BOT_ID } }
  failCreateWebhook = false
  messages = { fetch: async () => new Collection<string, never>() }
  permissionOverwrites = { edit: async () => {}, delete: async () => {} }
  constructor(
    public guild: FakeGuild,
    public id: string,
    public name: string,
    public parentId: string | null,
    public overwrites: { id: string; allow?: bigint[]; deny?: bigint[] }[],
    public topic?: string,
  ) {}
  isTextBased(): boolean {
    return true
  }
  async send(payload: Sent | string): Promise<{ id: string }> {
    if (typeof payload !== 'string') assertDiscordLimits(payload)
    this.sent.push(typeof payload === 'string' ? { content: payload } : payload)
    return { id: snow() }
  }
  async setName(name: string): Promise<this> {
    this.name = name
    return this
  }
  async delete(): Promise<this> {
    this.deleted = true
    this.guild.channelMap.delete(this.id)
    return this
  }
  async createWebhook(opts: { name: string }): Promise<FakeWebhook> {
    if (this.failCreateWebhook) throw new Error('Missing Permissions')
    const wh = new FakeWebhook(snow(), opts.name, `tok${snow()}`, this.webhooks)
    this.webhooks.push(wh)
    return wh
  }
  async fetchWebhooks(): Promise<Collection<string, FakeWebhook>> {
    return new Collection(this.webhooks.map((w) => [w.id, w]))
  }
}

export class FakeMember {
  roles: { cache: Set<string> }
  sentDMs: { content?: string }[] = []
  pending = false
  user: {
    id: string
    username: string
    globalName: string | null
    tag: string
    bot: boolean
    displayAvatarURL: () => string
  }
  constructor(
    public guild: FakeGuild,
    public id: string,
    opts: { username?: string; roles?: string[]; manageGuild?: boolean; pending?: boolean; bot?: boolean } = {},
  ) {
    const username = opts.username ?? `user${id.slice(-4)}`
    this.user = {
      id,
      username,
      globalName: null,
      tag: username,
      bot: Boolean(opts.bot),
      displayAvatarURL: () => 'https://cdn.example.test/a.png',
    }
    this.roles = { cache: new Set(opts.roles ?? []) }
    this.pending = Boolean(opts.pending)
    this.manageGuild = Boolean(opts.manageGuild)
  }
  manageGuild: boolean
  get permissions() {
    return { has: () => this.manageGuild }
  }
  async send(payload: { content?: string }): Promise<unknown> {
    this.sentDMs.push(payload)
    return {}
  }
}

export class FakeGuild {
  channelMap = new Map<string, FakeTextChannel | { id: string; type: ChannelType }>()
  memberMap = new Map<string, FakeMember>()
  available = true
  name = 'Test Guild'
  roles: { everyone: { id: string } }
  me: FakeMember
  constructor(public id: string = snow()) {
    this.roles = { everyone: { id: this.id } }
    this.me = new FakeMember(this, BOT_ID, { username: 'EuphoricTickets', bot: true })
    this.memberMap.set(BOT_ID, this.me)
    const g = this
    this.members = {
      async fetch(arg) {
        const id = typeof arg === 'string' ? arg : arg.user
        const m = g.memberMap.get(id)
        if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 })
        return m
      },
      get me() {
        return g.me
      },
      async fetchMe() {
        return g.me
      },
    }
  }
  addCategory(): string {
    const id = snow()
    this.channelMap.set(id, { id, type: ChannelType.GuildCategory })
    return id
  }
  addMember(opts: ConstructorParameters<typeof FakeMember>[2] = {}, id = snow()): FakeMember {
    const m = new FakeMember(this, id, opts)
    this.memberMap.set(id, m)
    return m
  }
  liveTextChannels(): FakeTextChannel[] {
    return [...this.channelMap.values()].filter((c): c is FakeTextChannel => c instanceof FakeTextChannel)
  }
  channels = {
    create: async (opts: {
      name: string
      parent?: string
      permissionOverwrites?: { id: string; allow?: bigint[]; deny?: bigint[] }[]
      topic?: string
    }): Promise<FakeTextChannel> => {
      const ch = new FakeTextChannel(this, snow(), opts.name, opts.parent ?? null, opts.permissionOverwrites ?? [], opts.topic)
      this.channelMap.set(ch.id, ch)
      return ch
    },
    fetch: async (id: string) => {
      const ch = this.channelMap.get(id)
      if (!ch) throw Object.assign(new Error('Unknown Channel'), { code: 10003 })
      return ch
    },
  }
  members: {
    fetch: (arg: string | { user: string; force?: boolean }) => Promise<FakeMember>
    readonly me: FakeMember
    fetchMe: () => Promise<FakeMember>
  }
}

export function fakeClient(...guilds: FakeGuild[]) {
  return {
    user: { id: BOT_ID },
    guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
  } as any
}

// A team (business) + a category, persisted, in a fresh fake guild.
export async function seedTeam(opts: {
  guild?: FakeGuild
  slug?: string
  adminRoleIds?: string[]
  staffRoleIds?: string[]
  category?: Partial<Pick<TicketCategory, 'key' | 'label' | 'staffRoleIds' | 'integrationOnly' | 'allowRoleIds' | 'staffOnly' | 'pingStaffOnOpen'>>
} = {}): Promise<{ guild: FakeGuild; business: Business; category: TicketCategory; parentId: string }> {
  const guild = opts.guild ?? new FakeGuild()
  const parentId = guild.addCategory()
  const [business] = await db
    .insert(businesses)
    .values({
      slug: opts.slug ?? `team-${randomUUID().slice(0, 8)}`,
      name: 'Test Team',
      discordGuildId: guild.id,
      adminRoleIds: (opts.adminRoleIds ?? []).join(','),
      staffRoleIds: (opts.staffRoleIds ?? []).join(','),
      discordFallbackCategoryId: parentId,
    })
    .returning()
  const [category] = await db
    .insert(ticketCategories)
    .values({
      businessId: business.id,
      key: opts.category?.key ?? 'newsong',
      label: opts.category?.label ?? 'New song',
      staffRoleIds: opts.category?.staffRoleIds ?? '',
      allowRoleIds: opts.category?.allowRoleIds ?? '',
      integrationOnly: opts.category?.integrationOnly ?? false,
      staffOnly: opts.category?.staffOnly ?? false,
      pingStaffOnOpen: opts.category?.pingStaffOnOpen ?? true,
    })
    .returning()
  return { guild, business, category, parentId }
}

// Flattens a sent Components-V2 payload to searchable JSON.
export function componentsJson(p: Sent | undefined): string {
  return JSON.stringify((p?.components ?? []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)))
}
