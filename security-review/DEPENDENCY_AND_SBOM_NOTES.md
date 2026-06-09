# Dependencies & SBOM Notes — Euphoric Tickets

Commit `d7c4c51`. Package manager: **pnpm 10.33.2** (lockfile present).
Node engine: images use `node:24-alpine`; review ran on Node 22.22.

`syft` / `grype` / `trivy` / `osv-scanner` are **not available** in the review
environment, so a CycloneDX/SPDX SBOM could not be auto-generated. The direct
dependency inventory and `pnpm audit` result are below; generate a full SBOM in CI
with `syft packages dir:. -o cyclonedx-json`.

## Direct dependencies

| Package | Version | Role | Notes |
|---|---|---|---|
| discord.js | ^14.26.3 (14.26.4) | gateway + REST client | current major; well-maintained |
| dotenv | ^17.4.2 | env loading | fine |
| drizzle-orm | ^0.45.2 | parameterized DB access | fine; no raw user-input SQL |
| postgres | ^3.4.9 | pg driver | fine |
| zod | ^4.4.1 (4.4.3) | env + modal input validation | fine |

## Dev dependencies

| Package | Version | Role | Notes |
|---|---|---|---|
| @types/node | ^25.7.0 | types | dev-only |
| drizzle-kit | ^0.31.10 | local schema tooling | **pulls the audit finding** (see below) |
| tsx | ^4.21.0 | dev/runtime TS exec | dev-only |
| typescript | ^6.0.3 | compiler | dev-only |

## `pnpm audit` result

```
1 vulnerabilities found — Severity: 1 moderate
esbuild <=0.24.2 — dev server can be made to send/read cross-origin requests
  path: . > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild
  advisory: GHSA-67mh-4wv8-2f99   patched: >=0.25.0
```

**Assessment: not exploitable in this service.**
- It is a **devDependency** chain (`drizzle-kit` → deprecated `@esbuild-kit/*`).
- The advisory only applies to running `esbuild --serve` (a dev server); the bot
  never does. No runtime exposure.
- **Caveat:** the current `Dockerfile` copies the **full** `node_modules`
  (including devDeps) into the production image, so this advisory is *shipped* even
  though it is unreachable. **F6's prod-only-deps change removes it from the image.**

## Supply-chain hygiene observations
- **postinstall scripts:** pnpm 10 blocks build scripts by default — install logged
  `Ignored build scripts: esbuild@…`. Good (no arbitrary postinstall ran).
- **Lockfile pinned:** `pnpm install --frozen-lockfile` succeeds; CI builds from
  the lockfile.
- **No typosquat-looking packages** in the direct or notable transitive set.
- **GitHub Actions** are pinned by tag, not commit SHA (F7) — `actions/checkout@v4`,
  `docker/*@v4-v6`, and the third-party `appleboy/ssh-action@v1.2.0`. Pin at least
  the third-party one to a SHA.

## Recommended CI additions
- `pnpm audit --prod` gate (so dev-only advisories don't block, but prod ones do).
- `syft` SBOM + `grype` scan of the built image.
- CodeQL (JavaScript/TypeScript) with SARIF upload.
- `gitleaks detect` on PRs.
