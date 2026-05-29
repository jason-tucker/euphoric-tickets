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

const envSchema = z.object({
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
