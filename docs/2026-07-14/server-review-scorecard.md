# Server Package Code Review Scorecard

**Reviewer**: Automated review agent (glm-5.2)
**Date**: 2026-07-15 (Re-review)
**Scope**: packages/server -- 42 source files, 17 route files, 17 lib modules, 11 test files
**Test Framework**: vitest (integration tests against real PostgreSQL)

---

## Progress vs Previous Review

| Dimension | Previous Score | New Score | Change |
|-----------|---------------|-----------|--------|
| Architecture & Organization | 7 | 8 | +1 |
| Security | 8 | 8 | 0 |
| Test Coverage | 7 | 7 | 0 |
| Performance | 6 | 6 | 0 |
| Maintainability | 7 | 8 | +1 |
| API Design | 6 | 7 | +1 |
| **Weighted Overall** | **7.00** | **7.50** | **+0.50** |

### Key Improvements Since Previous Review

1. **`as any` usage dropped from 186 to 1** -- the single remaining `as any` is in `db/connection.ts:19` (`sql.unsafe(text, params as any[])`), which is a legitimate typed-safe coercion for the postgres.js library signature. Nearly all handler `req`/`reply` parameters still use `: any` annotations (a Fastify convention), but the unchecked casts that spread throughout the codebase are gone.

2. **CORS origin restored**: Changed from `origin: true` (wildcard reflects any Origin) to `CORS_ORIGINS` with explicit localhost origins.

3. **Error format consistency fixed**: The `code:` prefix pattern that was unique to `auth.ts` has been removed. All route files now return `{ error: "message" }` uniformly.

4. **`hasMore` pagination bug fixed**: Both the thread messages endpoint and history endpoint now correctly compute `hasMore` by fetching one extra row.

5. **Dead deps partially cleaned**: `nanoid` and `zod` removed from package.json. `drizzle-orm` remains as a dependency (used at import time but never for runtime queries).

6. **`validatePassword` deduplicated**: Both `auth.ts` and `profile.ts` now import from the shared `lib/validators.ts`.

7. **Index.ts slimmed**: From 366 to 343 lines. Inline route registration extracted to proper files. However, 5 inline route handlers remain (`/api/health`, `/api/daemon/status`, `/api/users`, `/api/agents` CRUD).

8. **Agent test exists**: `test/agents.test.ts` now covers the internal agent list endpoint.


---

## Dimension 1: Architecture & Organization -- 8/10

| Metric | Value |
|--------|-------|
| Source files | 42 .ts files |
| Route files | 17 under src/routes/ |
| Library modules | 17 under src/lib/ |
| Main entry file | src/index.ts at 343 lines |
| Largest file | src/index.ts (343 lines) |
| Largest route file | src/routes/messages.ts (285 lines) |

### Done Well

- Clean domain-based route splitting. 17 route files each owning one domain.
- Separated library layer (lib/) for reusable logic: access control, DM, config, validators, etc.
- Internal vs. public API distinction. Agent API at /internal/agent/*.
- Plugin-based Fastify architecture used correctly throughout.
- Consistent file structure across all route files.
- 7 ordered SQL migration files covering schema, invites, notifications, Chinese search, metrics, and message edits.
- More lib modules extracted compared to previous review (17 vs. 14), indicating ongoing refactoring.

### Could Be Improved

- index.ts remains overstuffed at 343 lines. Contains inline handlers for 5 endpoints: `/api/health`, `/api/daemon/status`, `/api/users`, and full `/api/agents` CRUD (GET, POST, PATCH, DELETE).
- Duplicate agent creation: `routes/agents.ts` (internal) handles POST at `/internal/agent/register`, while `index.ts` handles POST at `/api/agents` (public) -- two code paths for the same domain.
- Four agent route modules all mounted at `/internal/agent` -- fragile if order matters.
- `routes/actions.ts` is 16 lines -- borderline as a separate file.
- Drizzle ORM types (`drizzle-pg.ts`, `schema.ts`) used only for type generation, never at runtime.

---

## Dimension 2: Security -- 8/10

### Done Well

- CSRF double-submit cookie pattern globally enforced, with proper exemptions for Bearer/machine token auth and login paths.
- CORS now uses `CORS_ORIGINS` with explicit origin list (was `origin: true` wildcard).
- HttpOnly, SameSite=Lax access_token cookie prevents XSS token theft.
- Bcrypt hashing at cost factor 12 for passwords and machine tokens.
- Brute-force login lockout: 5 attempts, 15-minute window.
- Machine tokens with `sk_machine_` prefix, stored as bcrypt hash.
- Rate limiting: auth 20/min, sensitive 5/min, general 100/min.
- Parameterized SQL everywhere.
- SSRF prevention in link preview.
- Upload MIME whitelist.
- Global error handler sanitizes stack traces.
- Graceful shutdown with WebSocket cleanup.

### Could Be Improved

- CRITICAL: Hardcoded Bearer dev-token auth bypass at `index.ts:89`. Now gated behind `process.env.NODE_ENV === "production"` (line 90), so it returns 401 in production. However, the bypass is still active in development mode. If a dev server is exposed to a network, this is exploitable.
- Rate-limiter test bypass via `process.env.NODE_ENV === "test"` (`rate-limit.ts:49`).
- Login lockout and rate-limit state are in-memory only -- lost on restart, not shared across instances.
- Config defaults for `JWT_SECRET`/`REFRESH_SECRET` are dev values. `validateConfig()` now logs a warning, but does not enforce.
- In-memory rate-limit state resets on restart -- no Redis persistence.

---

## Dimension 3: Test Coverage -- 7/10

### Done Well

- 11 test files using vitest against real PostgreSQL.
- 86 tests total, 10 files passing.
- Auth: register, login, wrong password, CSRF enforcement, sessions, deactivation, data export.
- Channels: CRUD, duplicate (409), missing name (400), members, invites, 404, DM resolution.
- DM isolation verified: non-member gets 403 on DM read.
- Tasks lifecycle end-to-end: create, claim, status transition, list.
- Agents internal endpoint test exists (`test/agents.test.ts`).
- Messages and notifications have test coverage.
- Clean infrastructure: registerUser(), cleanupTestData() with FK-safe deletion.

### Could Be Improved

- Zero unit tests. Core modules have no isolated tests.
- WebSocket layer (`ws/handler.ts`, 252 lines) has zero coverage.
- No notification, rate limit, file upload, reminder, or search tests.
- Agent internal API test is shallow (status 200 + is array only).
- Test count unchanged since previous review (86 tests).

---

## Dimension 4: Performance -- 6/10

### Done Well

- In-memory 2s TTL cache for channel type/member role lookups.
- DB connection pooling (default 10) with lifetime limits.
- Indexes on critical query patterns.
- Cursor-based pagination with before/after/around.
- Private channel broadcast narrows recipients via DB query.
- Metrics persistence on 60s interval, not per-request.
- Link preview limits to 256KB.
- **Improved**: @mention batch INSERT in messages.ts now uses `ANY($3)` with a single query instead of per-@ loop.

### Could Be Improved

- N+1 query pattern still present in `/api/agents` GET: queries agents, then maps over each row.
- No Redis caching for frequent reads in multi-instance deployments.
- `SELECT *` in RETURNING clauses on wide tables.
- No prepared statement reuse. Every query is `app.pg.query()` with inline SQL.
- No read replicas. All queries hit same pool.
- No query timeout configuration.
- No response compression.
- In-memory metrics counters lost on restart.

---

## Dimension 5: Maintainability -- 8/10

### Done Well

- Centralized config in `lib/config.ts`.
- Consistent route pattern across all files.
- Separate migration system with ordered SQL files.
- Centralized access control in `lib/access.ts` with caching.
- SQL fragment reuse in `query-fragments.ts`.
- Zero TODO/FIXME/HACK/XXX markers.
- Early-return error handling pattern.
- Good JSDoc on non-trivial utilities.
- **`as any` reduced from 186 to 1** -- the single remaining instance (`db/connection.ts:19`) is a tightly-scoped cast for postgres.js library compatibility.
- **Dead deps cleaned**: `nanoid`, `zod` removed from `package.json`.
- **`validatePassword` deduplicated** into `lib/validators.ts`.
- **7 migration files** providing clear schema evolution history.

### Could Be Improved

- `drizzle-orm` remains in package.json but is never used for runtime queries -- only for type declarations in `db/schema.ts` and `db/drizzle-pg.ts`.
- `ioredis` is `require()`-d (CJS) in `lib/rate-limit.ts` (an ESM module) -- line 29.
- `console.log()` used in `db/migrate.ts` and `db/seed.ts` instead of Fastify logger (acceptable for CLI scripts).
- Backward-compat `POST /api/profile` duplicates `PATCH /api/profile` handler (profile.ts:42-49).
- 2 files over 250 lines: `messages.ts` (285), `channels.ts` (266). `index.ts` at 343 lines is also a large file.

---

## Dimension 6: API Design -- 7/10

### Done Well

- RESTful HTTP method usage.
- Proper HTTP status codes (200, 400, 401, 403, 404, 409, 413, 415, 502).
- **Consistent error shape**: all routes now use `{ error: message }` without `code:` prefix.
- Swagger/OpenAPI docs at /docs.
- Pagination with limit, offset, before, after, around.
- DM target format `dm:@handle` is intuitive.
- CSRF double-submit is transparent.
- **`hasMore` pagination bug fixed**: both thread messages and history endpoints now correctly compute `hasMore` using the fetch-one-extra pattern.

### Could Be Improved

- Inconsistent response wrappers: some endpoints return `{ error: "..." }`, others return `{ state: "sent", messageId: ... }`, others return `{ ok: true }`.
- `POST /api/profile` legacy endpoint duplicates PATCH behavior (backward compat, but confusing).
- Mixed snake_case and camelCase in responses (e.g., auth.ts returns `displayName` from `display_name`).
- No API versioning (`/v1/`).
- Notification routes embed `/api/` in path strings directly instead of using prefix registration.

---

## Overall Assessment

| Dimension | Score | Weight | Weighted Score |
|-----------|-------|--------|----------------|
| Architecture & Organization | 8 | 20% | 1.60 |
| Security | 8 | 25% | 2.00 |
| Test Coverage | 7 | 15% | 1.05 |
| Performance | 6 | 10% | 0.60 |
| Maintainability | 8 | 15% | 1.20 |
| API Design | 7 | 15% | 1.05 |
| **Overall** | | **100%** | **7.50** |

### Top 3 Strengths

1. **Security posture remains strong and improved.** CSRF double-submit, HttpOnly cookies, bcrypt, brute-force lockout, SSRF protection, upload MIME whitelist, rate limiting, parameterized SQL -- all implemented correctly. CORS wildcard replaced with explicit origins.

2. **`as any` count reduced from 186 to 1** -- a massive maintainability win. The codebase is now much more type-safe and readable.

3. **Clean modular structure with ongoing improvement.** Routes split by domain, shared logic in `lib/`, Fastify plugins used idiomatically. Index.ts slimmed, more lib modules extracted, dead deps cleaned, validators deduplicated.

### Top 3 Improvement Opportunities

1. **Remove the dev-token auth bypass.** Even with the `NODE_ENV === "production"` guard, a developer exposing their dev server on a network is vulnerable. Replace with a proper admin token mechanism or remove entirely.

2. **Extract inline handlers from index.ts.** The 5 endpoints (`/api/health`, `/api/daemon/status`, `/api/users`, `/api/agents` CRUD) embedded directly in `index.ts` should live in dedicated route files. This would bring index.ts below 200 lines.

3. **Cover the WebSocket layer with tests.** At 252 lines with zero test coverage, `ws/handler.ts` is the largest untested module. Even a basic connection/handshake/echo test would significantly reduce risk.

---

## Issue Count by Severity

| Severity | Count | Examples |
|----------|-------|----------|
| CRITICAL | 1 | Dev-token auth bypass at index.ts:89 (NODE_ENV-guarded but still a backdoor) |
| HIGH | 3 | NODE_ENV rate-limit bypass, no WS tests (252 lines uncovered), drizzle-orm unused dep |
| MEDIUM | 3 | index.ts still overstuffed (343 lines, 5 inline handlers), POST legacy profile endpoint, mixed snake_case/camelCase responses |
| LOW | 2 | console.log in CLI scripts (migrate/seed), ioredis CJS require in ESM module |

**Verdict: WARNING** -- One CRITICAL issue (dev-token backdoor) remains must-fix before production. The re-review shows substantive improvement (+0.50 weighted score), driven primarily by the dramatic `as any` reduction, CORS fix, error format consistency, and hasMore bug fix.
