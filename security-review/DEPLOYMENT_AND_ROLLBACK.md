# Deployment & Rollback — security fixes (v0.7.1)

## Status

**Not deployed. Not pushed. No PR opened.** Per operator instruction, the fixes
(F1, F2, F4, F5) are committed to the local branch `claude/pensive-dirac-4e5f7g`
only. `tsc --noEmit` passes; the diff was code-reviewed with no findings.

## What changed (deploy impact)
- `src/bot/internalHttp.ts` — constant-time token compare + startup warning.
  **No protocol change** (the on-wire secret value is unchanged).
- `src/commands/tickets.ts` — close-confirm authorization re-check; `/tickets
  close` confirm is now ephemeral. **No schema/command-registration change.**
- `.dockerignore` (new), `.env.example` (docs only).
- `CHANGELOG.md` + `package.json` version bump 0.7.0 → 0.7.1.

No database migration. No slash-command surface change (so the CI
`registerCommands` step is a no-op for these edits). The build still produces the
same GHCR image shape.

## Normal pipeline (unchanged, `deploy.yml`)
1. Merge to `main` → GitHub Actions builds + pushes `ghcr.io/.../euphoric-tickets:latest` and `:sha-<sha>`.
2. Deploys slash commands (no-op for this change).
3. SSH to VPS → `docker compose pull && docker compose up -d`.
4. Watchtower also auto-pulls.

## Pre-deploy gates (recommended before any push)
- [ ] `node node_modules/typescript/bin/tsc --noEmit` → 0 (done locally).
- [ ] `pnpm audit --prod` → no prod advisories.
- [ ] Confirm `INTERNAL_TOKEN` is set on **both** bot and web (`.env`) — strongly
      recommended alongside F1 (not required for these fixes to work).
- [ ] Smoke: open a ticket, `/tickets close` → confirm dialog is ephemeral and
      only the authorized user can complete the close.

## Rollback
The deploy is image-based and pinned by SHA, so rollback is a re-pin:

```bash
# On the VPS — roll back to the previous image digest/sha tag:
BOT_IMAGE="ghcr.io/jason-tucker/euphoric-tickets:sha-<previous-sha>" \
  docker compose -f /home/botuser/projects/euphoric-tickets/docker-compose.yml up -d euphoric-tickets

docker compose logs -f euphoric-tickets   # verify "internal HTTP listening" + gateway login
```

Git-level rollback (if already merged): `git revert <merge-sha>` — the changes are
isolated and revert cleanly. No data migration to unwind.

## Post-deploy monitoring
- Watch for the new `log.warn('INTERNAL_TOKEN is not set …')` line — its presence
  confirms the F1 fallback is active and you should set a dedicated token.
- Confirm `/api/internal/dm` and notify dispatch still work (web→bot DM, bot→web
  notify) — the secret value is unchanged, so they should be unaffected.
- Confirm no spike in failed closes (the F2 re-check denies only the previously
  unauthorized path).
