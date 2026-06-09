# Threat Model — Euphoric Tickets (Discord bot)

Commit `d7c4c51`. Methodology: asset/boundary/attacker enumeration + STRIDE per
entrypoint. The bot is internet-adjacent only through Discord; it has **no public
HTTP listener** (the internal HTTP server is bound on a private docker network and
never published to the host per `docker-compose.yml`).

## Assets
- **`DISCORD_BOT_TOKEN`** — full control of the bot account. Highest-value.
- **Shared Postgres** (tickets, messages, audit logs, users) — confidential
  support content + PII (Discord IDs, usernames, message bodies, attachments).
- **`INTERNAL_TOKEN`** — authenticates web↔bot internal calls (today often == bot
  token; see F1).
- **Ticket channels** — confidentiality (private support) and integrity.
- **CI/CD secrets** — `VPS_SSH_KEY`, `GITHUB_TOKEN`, Discord creds.

## Trust boundaries
1. **Discord users → bot.** Untrusted: usernames, message content, attachments,
   slash-command options, modal text, button/select customIds.
2. **TicketTool (3rd-party bot) → bot.** Untrusted embed/message content ingested
   into `ticket_messages` and matched by regex.
3. **Web app → bot internal HTTP.** Semi-trusted, shared-secret authenticated.
4. **CI runner → GHCR/VPS.** Trusted pipeline; supply-chain exposure via actions.

## Attackers
- **Hostile guild member** (can click panel/welcome buttons, run slash commands,
  set their username, upload files, message in ticket channels).
- **Malicious/abusive staff** in a multi-team guild (cross-team reach — F3).
- **Network-adjacent container** on the shared docker network (must hold the
  internal secret — F1/F5).
- **Compromised dependency / moved action tag** (F7).
- **Token thief** (anyone who obtains `DISCORD_BOT_TOKEN`; blast radius widened by
  F1 reuse).

## Attack paths & dispositions

| Path | Vector | Disposition |
|---|---|---|
| SQL injection | command options, modal JSON, usernames | **Mitigated** — Drizzle parameterizes; raw `sql` fragments use only column refs / server values |
| `@everyone`/role-ping injection | ticket subject, rename, first-message template, status | **Mitigated** — `allowedMentions: { parse: [] }` on all user-derived sends |
| XSS via HTML transcript | message content, attachment names/URLs | **Low** — `escapeHtml` applied; file DM'd only to opener; URLs are Discord CDN |
| Channel/role-overwrite injection | usernames in channel name/topic | **Low** — name is `[^a-z0-9]`-stripped + length-capped; topic is plain text (no markup context) |
| Close/delete a ticket without rights | added non-staff member clicks public confirm | **FIXED (F2)** |
| Cross-team action in multi-team guild | guild-default role gate on button handlers | **Open (F3)** — bounded by Discord channel visibility |
| Forge a button interaction for another ticket | crafted customId | **Not exploitable** — Discord won't deliver interactions for unseen messages; handlers act on the interaction's channel |
| Internal HTTP abuse | hit `/api/internal/*` from the docker network | **Mitigated** — shared-secret auth; timing-safe compare (F5); 16KB body cap. Residual: secret may be the bot token (F1) |
| SSRF | bot `fetch()` to attacker URL | **Not present** — fetch targets are operator-config URLs (`WEB_BASE_URL`, `UPTIME_KUMA_PUSH_URL`), not user input |
| Secret exfiltration via build cache | `.env`/`.git` into image layer | **FIXED (F4)** |
| Ticket spam / DoS | rapid open | **Partial** — dedupe caps to one open ticket per (user,category); no cooldown (low) |
| Unbounded ingest/backfill | huge channel / many TicketTool tickets | **Low (F10)** — `fetchAllMessages` hard-cap 2000; backfill cap 100; reconcile unbounded concurrency |
| CI compromise | moved action tag, untrusted PR | **Low (F7)** — deploy triggers on push-to-main + dispatch only (no `pull_request`); third-party action unpinned |

## Blast radius
- **Bot token leak:** total bot-account takeover across every guild; with F1
  unaddressed, also unlocks the internal HTTP endpoints. → set a dedicated
  `INTERNAL_TOKEN`.
- **DB credential leak:** read/write to all tenants' tickets/messages (the bot
  connects with broad rights; tenant isolation is enforced in app code, not at the
  DB layer).
- **VPS SSH key leak (CI):** host compromise.

## Highest-priority hardening
1. Retire the bot-token internal-secret fallback (F1 manual action).
2. Land F3 so multi-team isolation holds at every entrypoint, not just slash
   commands.
3. Non-root container + prod-only deps (F6); pin CI actions (F7).
