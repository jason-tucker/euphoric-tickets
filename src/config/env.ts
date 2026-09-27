import { z } from 'zod'
import 'dotenv/config'

const SNOWFLAKE_RE = /^\d{17,20}$/

// Coerce empty strings (common when copying .env.example) to undefined so
// optional validators don't reject them. Without this, an unfilled
// `UPTIME_KUMA_PUSH_URL=` line in .env crashes startup with "Invalid URL".
for (const key of [
  'UPTIME_KUMA_PUSH_URL',
  'SUDO_ROLE_IDS',
  'SUDO_USER_IDS',
  'BOT_OWNER_ID',
  'WEB_BASE_URL',
  'WEB_INTERNAL_URL',
  'INTERNAL_TOKEN',
]) {
  if (process.env[key] === '') delete process.env[key]
}

const csvSnowflakes = z
  .string()
  .optional()
  .refine(
    (val) => {
      if (val === undefined) return true
      const tokens = val.split(',').map((s) => s.trim()).filter(Boolean)
      return tokens.every((t) => SNOWFLAKE_RE.test(t))
    },
    { message: 'each entry must be a Discord snowflake' },
  )

// P1c (plan §4.6 step 5): the web↔bot internal channel authenticates ONLY with
// a dedicated INTERNAL_TOKEN of at least this many characters. There is no
// DISCORD_BOT_TOKEN fallback; a missing or short token fails env validation and
// the process exits at boot.
export const INTERNAL_TOKEN_MIN_LENGTH = 32

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().regex(SNOWFLAKE_RE, 'must be a Discord snowflake'),
  GUILD_ID: z.string().regex(SNOWFLAKE_RE, 'must be a Discord snowflake'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SUDO_ROLE_IDS: csvSnowflakes,
  SUDO_USER_IDS: csvSnowflakes,
  BOT_OWNER_ID: z.string().regex(SNOWFLAKE_RE, 'must be a Discord snowflake').optional(),
  UPTIME_KUMA_PUSH_URL: z.string().url().optional(),
  // Public URL of the web companion app — used for the "view in web" link
  // in close-ticket DMs and elsewhere. Defaults to the production host.
  WEB_BASE_URL: z.string().url().default('https://tickets.euphoric.fm'),
  // Private-network URL of the web companion (e.g. http://tickets-web:3000),
  // used ONLY for bot → web server-to-server calls (the notify bridge) so they
  // never leave the Docker network or depend on the public edge. Links shown to
  // humans keep using WEB_BASE_URL. Unset = fall back to WEB_BASE_URL.
  WEB_INTERNAL_URL: z.string().url().optional(),
  // P13 / P1c: shared secret authenticating every web ↔ bot internal call
  // (x-internal-token on the internal HTTP server and the notify bridge).
  // Required, ≥ 32 characters, same value as the web app's. Never the bot token.
  INTERNAL_TOKEN: z
    .string({ error: 'INTERNAL_TOKEN is required (a dedicated secret shared with the web app; openssl rand -hex 32)' })
    .min(INTERNAL_TOKEN_MIN_LENGTH, `INTERNAL_TOKEN must be at least ${INTERNAL_TOKEN_MIN_LENGTH} characters`),
  // Port the bot's tiny internal HTTP server binds (DM dispatch). Default 8787.
  INTERNAL_PORT: z.coerce.number().int().positive().default(8787),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

const raw = parsed.data

const splitCsv = (val: string | undefined): string[] =>
  (val ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export const env = {
  ...raw,
  sudoRoleIds: splitCsv(raw.SUDO_ROLE_IDS),
  sudoUserIds: splitCsv(raw.SUDO_USER_IDS),
}
