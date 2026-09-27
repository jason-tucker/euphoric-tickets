// Minimal discord.js stand-ins: just the surface the ticket code touches.
import { randomUUID } from 'node:crypto'
import { ChannelType, Collection } from 'discord.js'
import { db } from '../src/db/client'
import { businesses, ticketCategories, type Business, type TicketCategory } from '../src/db/schema'

let seq = BigInt(Date.now()) * 1000n
export const snow = (): string => String(100000000000000000n + (seq++ % 800000000000000000n))

export const BOT_ID = '100000000000000009'

export type Sent = { content?: string; components?: { toJSON(): unknown }[]; [k: string]: unknown }

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
  category?: Partial<Pick<TicketCategory, 'key' | 'label' | 'staffRoleIds' | 'integrationOnly' | 'allowRoleIds' | 'staffOnly'>>
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
    })
    .returning()
  return { guild, business, category, parentId }
}

// Flattens a sent Components-V2 payload to searchable JSON.
export function componentsJson(p: Sent | undefined): string {
  return JSON.stringify((p?.components ?? []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)))
}
