# Euphoric Tickets

Discord ticket bot for the Euphoric community.

## What it does

- **Ticket panels.** Sudo posts a panel in any channel via `/panel post`. Members click a button to open a ticket. The bot creates a private channel under the configured tickets category, visible only to the opener and staff roles.
- **Claim / close.** Staff can claim a ticket (assigns ownership, posts a notice). Closing a ticket renders an HTML transcript, posts it to the transcript channel, and deletes the ticket channel.
- **Settings.** `/tickets settings` (sudo-only) configures the tickets category, staff role IDs, transcript channel, and panel categories. All settings are DB-backed so they survive redeploys.

## Stack

- TypeScript + discord.js v14, Components V2
- Postgres + Drizzle ORM (`drizzle-kit push` at container start — no SQL migration files)
- Docker + GHCR build, watchtower auto-update on the VPS
- pnpm package manager

## Local dev

```bash
pnpm install
cp .env.example .env  # fill in DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, SUDO_USER_IDS
docker compose up -d db
pnpm db:push
pnpm commands:deploy
pnpm dev
```

## Production

```bash
# First time on the VPS:
git clone https://github.com/jason-tucker/euphoric-tickets.git ~/projects/euphoric-tickets
cd ~/projects/euphoric-tickets
cp .env.example .env && nano .env
docker network create botpanel-net 2>/dev/null || true   # only if sharing with botpanel
docker compose up -d
```

Subsequent deploys are automatic: push to `main` → GitHub Actions builds → pushes to GHCR → watchtower pulls and restarts.

## Commands

| Command | Access | What it does |
|---|---|---|
| `/panel post` | Sudo | Posts the ticket panel to the current channel |
| `/panel refresh` | Sudo | Re-renders an existing panel after settings change |
| `/tickets settings` | Sudo | DB-backed configuration: category, transcript channel, log channel, staff roles, panel categories |
| `/tickets claim` | Staff | Claim the current ticket |
| `/tickets close` | Staff / opener | Close the current ticket — saves transcript, DMs opener, deletes channel |
| `/tickets add <user>` | Staff | Add a member to the current ticket |
| `/tickets remove <user>` | Staff | Remove a member from the current ticket (opener excluded) |
| `/tickets rename <name>` | Staff | Rename the current ticket channel (slugified, keeps `ticket-<id>-` prefix) |
| `/tickets list` | Staff | List every open ticket in the guild |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token |
| `DISCORD_CLIENT_ID` | Yes | Application ID |
| `GUILD_ID` | Yes | The single guild this bot serves |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SUDO_ROLE_IDS` | No | Comma-separated Discord role IDs with bot-admin powers |
| `SUDO_USER_IDS` | No | Comma-separated user IDs with bot-admin powers |
| `BOT_OWNER_ID` | No | Receives DM on startup |
| `UPTIME_KUMA_PUSH_URL` | No | Kuma push monitor URL |
| `BOT_IMAGE` | No | Override the GHCR image tag |
| `POSTGRES_PASSWORD` | Yes | Postgres password (compose only) |

`euphoric-tickets v0.2.1 · 7368229`
