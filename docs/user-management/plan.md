# User management — implementation plan

Status: draft for review · 2026-11-01
Related: [spec.md](spec.md) · [tasks.md](tasks.md)

## 1. Architecture

```
Browser (index.html + app.js, admin.html + admin.js)
   │  same origin: cookie session + X-CSRF-Token
   ▼
Flask app (gunicorn)
   ├─ /                 static front end  (web/)
   ├─ /b/<id>           serves index.html; app.js loads the board
   ├─ /admin            serves admin.html (admins only)
   ├─ /auth/*           Google OIDC via Authlib
   └─ /api/*            JSON API (blueprints)
   ▼
SQLAlchemy ──► PostgreSQL (production) / SQLite (dev, tests)

Browser ──► Google Drive / Anthropic API directly, as today (unchanged)
```

## 2. Technology choices

| Need | Choice | Why |
|---|---|---|
| Web framework | Flask 3, app factory + blueprints | Requested; small and well known |
| ORM / migrations | Flask-SQLAlchemy 3, Flask-Migrate | Standard; same code on SQLite and Postgres |
| Google sign-in | Authlib (Flask client, OIDC) | Handles state, nonce and ID-token checks |
| Rate limiting | Flask-Limiter | Simple per-route limits |
| Production server | gunicorn | Common on every Python host |
| Tests | pytest, pytest-cov, Flask test client | |
| Browser tests | Playwright for Python | Drives the real app in Chromium and WebKit (Safari's engine) |
| Lint / format | ruff | One fast tool |
| CI | GitHub Actions | Runs lint + tests on every push / PR |

CSRF is checked by a small custom check (token in the session, compared with `X-CSRF-Token`, plus
an `Origin` check) rather than Flask-WTF, because the API is JSON-only.

## 3. Repository layout (target)

```
web/                     front end (moved from the repo root)
  index.html  app.js  style.css  privacy.html
  admin.html  admin.js   (new)
server/
  chalkback/
    __init__.py          create_app(config)
    config.py            Dev / Test / Prod config from env vars
    extensions.py        db, migrate, oauth, limiter
    models.py            User, Board, BoardShare, AuditLog
    security.py          session loading, login_required, admin_required, CSRF, headers
    auth.py              /auth blueprint
    api/
      me.py  boards.py  shares.py  admin.py
    services/
      boards.py          access rules, limits, versioning
      accounts.py        deletion, export, admin guards
    validation.py        board JSON checks (spec §6.5)
  migrations/
  tests/
    conftest.py          app, db, client, user/admin fixtures, fake Google
    test_*.py
  e2e/                   Playwright tests
pyproject.toml           dependencies, ruff, pytest config
.env.example
.github/workflows/ci.yml
docs/user-management/    this spec, plan, tasks
```

The front end moves to `web/` in a commit of its own (no content changes), so history stays easy
to follow.

## 4. Front-end changes (app.js)

app.js is one IIFE with sections. New sections are added in the same style:

- **Account**: fetches `/api/me` at start-up, shows a sign-in button or an avatar menu (top-right
  panel), holds the CSRF token, and wraps `fetch` for API calls (CSRF header, JSON errors to toasts).
- **Cloud boards**: tracks the current board's `{id, version, permission}`, debounced server
  autosave alongside the existing local save, the save-status indicator, conflict dialog, routing
  for `/b/<id>`, and the "My boards" panel.
- **Sharing**: share dialog (owner) and leave action.
- **View-only**: reuses the replay approach (`inert` editing groups, drawing disabled).
- **Settings**: a new Account section (display name, sign out, sign out everywhere, export, delete).

`serialize()` / `validateBoard()` / `useBoard()` are reused as they are; a cloud board's data is
exactly the autosave JSON.

## 5. Phases

Each phase ends in a working, tested, deployable state. A phase is done when all its tasks in
[tasks.md](tasks.md) meet their test criteria and CI is green.

| Phase | Outcome | Depends on |
|---|---|---|
| **P0 Setup** | Decisions made, Google Cloud configured, host + Postgres chosen | — |
| **P1 Skeleton** | Flask serves today's app unchanged at `/`; config, headers, CI, test harness | P0 |
| **P2 Data model** | Models + first migration | P1 |
| **P3 Sign-in** | Google sign-in/out, sessions, CSRF, `/api/me`, front-end account menu | P2 |
| **P4 Boards** | Boards API, autosave to account, My boards, `/b/<id>`, conflicts, import local board | P3 |
| **P5 Sharing** | Shares API, share dialog, view-only mode, leave | P4 |
| **P6 Self-service** | Display name, sign out everywhere, export, delete account | P4 |
| **P7 Admin** | Admin API, console, guards, audit log, bootstrap | P3 (P6 for delete) |
| **P8 Launch** | Privacy policy, deploy, browser + iPad test pass, retire GitHub Pages | all |

P5, P6 and P7 can be built in parallel once P4 is done.

## 6. Testing strategy

| Level | What | Tool | Where |
|---|---|---|---|
| Unit | validation, access rules, limits, guards | pytest | `server/tests/` |
| API / integration | every endpoint: success, auth, permission, validation, limits | pytest + Flask test client, SQLite in memory | `server/tests/` |
| Migrations | upgrade from empty and downgrade back, on SQLite and Postgres | pytest + Alembic | CI (Postgres service) |
| End-to-end | sign-in, save/open, share, view-only, conflict, admin, delete | Playwright (Chromium + WebKit) | `server/e2e/` |
| Manual | iPad Safari + Apple Pencil, real Google sign-in, real Drive | checklist in tasks.md | before launch |

- **Faking Google**: unit and API tests replace Authlib's token exchange with a fake that returns
  chosen claims (`sub`, `email`, `email_verified`, `name`). E2E tests use a test-only sign-in route
  that is registered **only** when `TESTING=True`; a test asserts it doesn't exist under the
  production config.
- **Coverage**: at least 90% line coverage on `server/chalkback`, enforced in CI.
- **Regression**: the existing drawing features get an e2e smoke test (draw, undo, board style,
  replay, PDF export) that runs signed out and signed in.
- **Security tests** are ordinary test cases: missing or wrong CSRF token, foreign `Origin`, IDOR
  attempts (another user's board / share ids), `next` open-redirect attempts, oversize bodies, and
  a disabled user's or bumped-epoch session.

## 7. Rollout

1. Deploy to the chosen host on a staging URL; add that URL's redirect URI in Google Cloud.
2. Run the e2e suite against staging, then the manual checklist (including iPad).
3. Update privacy.html and the OAuth consent screen, then deploy production.
4. Announce the new address. Keep GitHub Pages up for a transition period with a banner
   ("ChalkBack has moved — export your board here, then open it there").
5. Retire GitHub Pages.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Origin change strands local boards (spec §13.4) | Transition banner; Drive save/open as a bridge; "save local board to account" prompt |
| Big boards (images) make autosave heavy | 2 s debounce, size limits, only save when changed; delta saves later if needed |
| Lost edits from concurrent editing | Versioned saves with 409 and a conflict dialog; local cache |
| SQLite data loss on hosts with wiped disks | Postgres in production (enforced by config check) |
| Google consent / verification delays | Scopes `openid email profile` are non-sensitive; start P0 early |
| app.js keeps growing (already ~2,000 lines) | New code in clearly marked sections; consider splitting into modules once the feature is in |
