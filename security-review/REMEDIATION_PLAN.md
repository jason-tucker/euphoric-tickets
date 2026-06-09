# Remediation Plan — Euphoric Tickets

Base commit `d7c4c51` (v0.7.0) · branch `claude/pensive-dirac-4e5f7g`.
Operator-selected scope: **apply high-severity fixes only (F1, F2, F4, F5)**;
document the rest. No push / PR / deploy this pass.

## Applied this pass

### F2 — Missing authorization at close-confirm (Medium) ✅
- **Where:** `src/commands/tickets.ts` — `closeHere`, `executeCloseConfirm`.
- **Problem:** `executeCloseConfirm` (the wired confirm handler) performed **no**
  permission check, and `/tickets close` posted the "Close & delete" confirm
  **non-ephemerally**. A member added to a ticket via `/tickets add` (who is
  neither staff nor opener) could click it and delete the channel.
- **Fix:** `executeCloseConfirm` now resolves access via
  `resolveTicketAccessByChannel(closer, business, interaction.channelId)` and
  rejects unless `access.canClose`. Resolving **by channel** (not the customId's
  `ticketId`) also fixes the prior mismatch where it could close a ticket-by-id
  while deleting the current channel. The `/tickets close` confirm is now
  `Ephemeral`, matching the welcome-card path.
- **Residual:** none for this vector. The initial Close button on the welcome
  card stays public by design but is gated by `handleTicketClose`.

### F1 — Internal secret falls back to the bot token (Medium) ✅ (mitigation)
- **Where:** `src/bot/internalHttp.ts`, `src/services/notifyBridge.ts`, `.env.example`.
- **Problem:** when `INTERNAL_TOKEN` is unset, `DISCORD_BOT_TOKEN` is used as the
  internal HTTP shared secret in both directions and is sent on the wire to
  `WEB_BASE_URL`. Reuses the most sensitive credential as an auth header.
- **Fix (non-breaking):** loud `log.warn` at startup when `INTERNAL_TOKEN` is
  unset; documented `INTERNAL_TOKEN` (+ `WEB_BASE_URL`, `INTERNAL_PORT`) in
  `.env.example` with generation guidance.
- **Why not mandatory:** making `INTERNAL_TOKEN` required, or deriving a
  different on-wire secret, would break the cross-repo contract (the web app uses
  the same `INTERNAL_TOKEN ?? DISCORD_BOT_TOKEN` fallback). Retiring the fallback
  is a **coordinated config action** (see Manual actions).

### F5 — Non-constant-time token comparison (Low→Med) ✅
- **Where:** `src/bot/internalHttp.ts`.
- **Fix:** `tokenMatches()` uses `crypto.timingSafeEqual` with a `typeof`/length
  guard so it never throws; replaces `req.headers['x-internal-token'] !== secret`.

### F4 — No `.dockerignore` (Medium) ✅
- **Where:** new `/.dockerignore`.
- **Fix:** excludes `.git`, `node_modules`, `dist`, `.env*` (keeps `.env.example`),
  `.claude/`, logs, `*.tsbuildinfo`, and `security-review/` from the build
  context, while preserving everything the builder needs (`src/`, `tsconfig.json`,
  manifests, `drizzle.docker.config.cjs`, `scripts/`).

**Verification:** `node node_modules/typescript/bin/tsc --noEmit` → exit 0.
Code-review pass on the diff → no correctness findings.

## Deferred (documented, not changed)

### F3 — Multi-team authorization drift (Medium) — recommended next PR
Route these through the ticket's **own** team instead of the guild default:
- `src/interactions/buttons/ticketClose.ts:28` — replace `getStaffRoleIds(guildId)`
  + global ticket fetch with `resolveTicketAccessByChannel(...).access.canClose`.
- `src/interactions/buttons/ticketClaim.ts:24` — same, gate on `access.canClaim`.
- `src/interactions/buttons/ticketChangeCategory.ts:24,69` — resolve the ticket's
  business and verify `ticket.businessId === business.id` (or resolve-by-channel)
  before `isAdminForBusiness`.
- `src/commands/tickets.ts:663` (`listTickets`) — already scopes the list query by
  `business.id`, but the *staff gate* uses guild-default roles; align it.
Behavior-shift risk on single-team servers is ~nil (default team == only team);
the value is correctness on multi-team guilds. Add tests with two businesses.

### F6 — Container hardening — Dockerfile
```dockerfile
# production stage
RUN addgroup ... || true   # node:alpine already ships a `node` user
COPY --chown=node:node --from=builder /build/dist ./dist
# install prod-only deps in the runtime stage instead of copying full node_modules:
#   COPY --from=builder /build/package.json /build/pnpm-lock.yaml ./
#   RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile
USER node
HEALTHCHECK CMD node -e "process.exit(0)"   # or probe the heartbeat
```
Pruning devDeps also removes the `esbuild` advisory from the shipped image.

### F7 — CI hardening — `.github/workflows/deploy.yml`
- Pin `appleboy/ssh-action` (and ideally docker/* actions) to a commit SHA.
- Add a separate **non-blocking** workflow on PR: `tsc --noEmit`, `pnpm audit`,
  gitleaks, and CodeQL; upload SARIF. Keep it off the deploy critical path.
- Optionally generate an SBOM (`syft`) and build provenance on release.

### F8 — Reliability
- `healthPush.ts:13`, `notifyBridge.ts:19`: pass `signal: AbortSignal.timeout(5000)`.
- `internalHttp.ts`: return the `server` handle; `server.close()` in
  `index.ts` `gracefulShutdown`.
- `leader.ts:26`: move `LEADER_ELECTION` into the zod env schema as an enum.

### F9 — Tests
Add `vitest` (dev-only; never built on the VPS). Cover `tokenMatches` (equal /
unequal / length-mismatch / array header), `escapeHtml`, `validatePanelCategoriesJson`,
the rename slugify, and an authz matrix for `resolveTicketAccess`
(unauth / wrong-user / wrong-role / cross-tenant).

### F10 / F11 — Informational
- Cap untrusted text length before regex in `ticketToolIngest`; bound
  reconcile/reprocess concurrency (mirror `startupResync`'s batch-of-5).
- `lantern-bootstrap.sh`: replace the fixed `/tmp/.b` with `mktemp`.

## Manual actions (operator)
1. **Set a dedicated `INTERNAL_TOKEN`** (`openssl rand -hex 32`) in **both** the
   bot `.env` and the web app; redeploy both. Then the bot-token fallback is never
   used. No secret rotation otherwise needed — none were exposed.
2. Enable branch protection on `main` + GitHub secret scanning / push protection.
3. Review and merge F3 as a focused PR with multi-team tests before relying on
   multi-team isolation.
