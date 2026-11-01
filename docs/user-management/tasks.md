# User management — tasks and test criteria

Status: draft for review · 2026-11-01
Related: [spec.md](spec.md) · [plan.md](plan.md)

## Progress (2026-11-01)

Built on branch `feature/user-management`. Automated checks run locally: 105 server tests pass
(99% coverage; the 2 PostgreSQL migration tests run in CI), 23 browser tests pass in Chromium and
WebKit, and ruff is clean.

| Task | Status |
|---|---|
| T0.1 Host + Postgres provider | Decided: Vercel + Neon Postgres — config in `vercel.json`, `api/index.py` |
| T0.2 Google Cloud redirect URIs, client secret, consent scopes | **Open — owner action** |
| T0.3 Retention, limits shown, domain | **Open — owner decision** (built as specified: immediate deletion) |
| T1.1–T1.4 Move to `web/`, app factory, headers, tooling | Done — `test_app.py` |
| T1.3 manual: Drive, Picker, PDF and AI preview with no CSP errors | **Open — manual** |
| T1.5 CI workflow | Done locally — `.github/workflows/ci.yml` runs on the first push |
| T1.6 E2E harness + smoke test | Done — `e2e/test_signed_out.py` |
| T2.1–T2.2 Models, migration | Done — `test_models.py`, `test_migrations.py` |
| T3.1–T3.4 Sessions, sign-in, `/api/me`, account menu | Done — `test_security.py`, `test_auth.py`, `e2e/test_boards.py` |
| T3.2 manual: real Google sign-in (localhost and iPad on staging) | **Open — needs T0.2** |
| T4.1–T4.6 Validation, boards API, autosave, list, conflicts, import | Done — `test_validation.py`, `test_boards.py`, `e2e/test_boards.py` |
| T4.3 manual: quick Pencil strokes during autosave on iPad | **Open — manual** |
| T5.1–T5.3 Sharing API, dialog, view-only | Done — `test_shares.py`, `e2e/test_sharing_account_admin.py` |
| T6.1–T6.4 Display name, sign out everywhere, export, delete | Done — `test_me.py`, e2e |
| T7.1–T7.2 Admin API and console | Done — `test_admin.py`, e2e; manual iPad check open |
| T8.1 Privacy policy | Drafted — **owner review**; hosting provider and children's policy marked TODO |
| T8.2 Deployment | Procfile, `/healthz`, env template done — **deploy open (needs T0.1)** |
| T8.3 Manual test pass | **Open** |
| T8.4 Move off GitHub Pages | **Open** |

Each task lists **Done when**: the automated tests that must exist and pass, plus any manual
checks. Test names are suggestions; what matters is the behaviour they check. Tick a task only
when all of its criteria pass in CI (or, for manual checks, have been carried out and noted in the
PR).

## Definition of done (every task)
- [ ] Code follows the existing style; no secrets in the repo.
- [ ] New and changed behaviour is covered by tests; `pytest` and `ruff` pass in CI.
- [ ] Coverage of `server/chalkback` stays ≥ 90%.
- [ ] Signed-out drawing still works: the e2e smoke test passes (from T1.6 onward).
- [ ] Docs updated if behaviour or config changed (`.env.example`, this file, privacy.html).

---

## P0 — Setup

**T0.1 Decide the host and Postgres provider** (spec §13.1)
- Done when: the decision is recorded in spec §13 with cost, region and backup policy.

**T0.2 Configure Google Cloud for server sign-in**
- Add authorised redirect URIs: `http://localhost:5000/auth/callback`, the staging URL and the
  production URL. Create the client secret. Add scopes `openid email profile` to the consent
  screen.
- Done when: a manual sign-in on localhost reaches `/auth/callback` with a code (checked in T3.2).

**T0.3 Answer the remaining open questions** (retention, limits shown to users, domain)
- Done when: spec §13 is updated with the answers.

## P1 — Flask skeleton

**T1.1 Move the front end to `web/`**
- A move-only commit: `git mv` of index.html, app.js, style.css and privacy.html.
- Done when: `git log --follow web/app.js` shows the full history, and the files are byte-identical.

**T1.2 App factory, config and static serving**
- `create_app()` with Dev/Test/Prod config from env vars; serve `web/` at `/`; `/b/<id>` serves
  index.html.
- Done when:
  - `test_index_served`: GET `/` → 200, HTML contains `<canvas id="canvas">`.
  - `test_static_assets`: `/app.js` and `/style.css` → 200 with the correct content types.
  - `test_board_route_serves_app`: GET `/b/abc` → 200, same HTML as `/`.
  - `test_prod_requires_secrets`: the Prod config with `SECRET_KEY` or `DATABASE_URL` missing
    fails at start-up with a clear error.
  - `test_prod_rejects_sqlite`: the Prod config with a `sqlite:` URL fails at start-up.

**T1.3 Security headers**
- Move the CSP from the `<meta>` tag into a response header, add `frame-ancestors 'none'`, nosniff,
  Referrer-Policy, and HSTS (Prod only).
- Done when:
  - `test_security_headers`: every response type (HTML, JS, JSON, 404) carries the headers.
  - `test_csp_matches_previous_policy`: the header contains every source the old meta tag allowed.
  - `test_no_hsts_in_dev`.
  - Manual: in Chrome, Drive sign-in, the Picker, PDF export and the AI preview still work with no
    CSP errors in the console.

**T1.4 Tooling**: pyproject.toml (dependencies, ruff, pytest, coverage), `.env.example`.
- Done when: `pip install -e .[dev]` followed by `pytest` runs on a clean checkout.

**T1.5 CI workflow**: GitHub Actions running ruff, pytest with coverage, and a Postgres service.
- Done when: a PR shows the green check, and a deliberately failing test turns it red.

**T1.6 E2E harness + drawing smoke test**
- Playwright (Chromium + WebKit) starts the app via a fixture.
- Done when: `test_smoke_signed_out` draws a stroke, undoes and redoes it, changes the board style,
  reloads, and asserts the stroke and style persisted, with no console errors. It passes on both
  engines.

## P2 — Data model

**T2.1 Models**: User, Board, BoardShare, AuditLog as in spec §5, with constraints (unique
`google_sub`, unique email, unique (board, email) share; role/status/permission enums).
- Done when:
  - `test_user_unique_sub_and_email`: duplicates raise an integrity error.
  - `test_share_unique_per_board_email`.
  - `test_public_ids_random_and_unique`: 1,000 generated ids are unique, URL-safe and ≥ 22
    characters.
  - `test_cascade_delete_board_removes_shares`.

**T2.2 First migration**
- Done when: `test_migration_upgrade_downgrade` runs upgrade → downgrade → upgrade cleanly on
  SQLite and on Postgres (CI), and `flask db check` reports no drift from the models.

## P3 — Sign-in

**T3.1 Session loading and guards**: `current_user` from the session (id + epoch),
`login_required`, `admin_required`, CSRF token generation and checks, Origin check.
- Done when:
  - `test_anonymous_me_returns_null_user`.
  - `test_session_with_wrong_epoch_is_signed_out`.
  - `test_disabled_user_session_rejected` → 401 and the session is cleared.
  - `test_state_change_without_csrf_rejected` → 403; `test_wrong_csrf_rejected` → 403.
  - `test_foreign_origin_rejected` → 403 even with a valid token.
  - `test_get_requests_do_not_need_csrf`.

**T3.2 Google sign-in** (`/auth/login`, `/auth/callback`, `/auth/logout`)
- Done when (Google faked):
  - `test_login_redirects_to_google` with state and nonce.
  - `test_callback_creates_user` on first sign-in; `test_callback_updates_profile` on later ones
    (same `sub`, new name or email).
  - `test_callback_rejects_unverified_email`.
  - `test_callback_rejects_bad_state` (CSRF on sign-in).
  - `test_disabled_user_cannot_sign_in` → redirected with an error message, no session.
  - `test_admin_emails_bootstrap`: an email in `ADMIN_EMAILS` gets role admin at sign-in.
  - `test_next_param_local_only`: `next=/b/x` is honoured; `next=https://evil.com`, `//evil.com`
    and `/\evil.com` fall back to `/`.
  - `test_logout_clears_session`.
  - `test_session_cookie_flags`: HttpOnly, SameSite=Lax, and Secure in Prod.
  - `test_google_tokens_not_stored`: after sign-in, no Google token is in the DB or the session.
  - Manual: real Google sign-in on localhost in Chrome, and in iPad Safari against staging.

**T3.3 `/api/me`**: GET returns the profile, role and `csrfToken`.
- Done when: `test_me_signed_in` returns the expected fields and never returns `google_sub`.

**T3.4 Front end: account menu**
- Sign-in button when signed out; avatar menu (name, email, Sign out) when signed in; API helper
  that sends CSRF and turns errors into toasts.
- Done when:
  - E2E `test_sign_in_and_out` (test sign-in route): the avatar appears, then signing out restores
    the sign-in button.
  - E2E `test_signed_out_app_unchanged`: the smoke test passes, and no `/api/*` call other than
    `/api/me` is made.
  - Manual: the menu works with touch on iPad and doesn't cover the toolbar at phone width.

## P4 — Boards

**T4.1 Board validation** (spec §6.5)
- Done when: `test_validation_accepts_real_saves` uses fixtures exported from the current app (v1,
  v2, with images, board style and history); `test_validation_rejects` covers non-object, wrong
  `v`, unknown top-level field, invalid JSON and oversize → 422/413.

**T4.2 Boards API**: list, create, get, save (versioned), rename, delete, copy; limits.
- Done when:
  - `test_create_and_get_roundtrip`: the data saved equals the data returned.
  - `test_list_owned_and_shared` with correct permission fields; list responses contain no `data`.
  - `test_save_increments_version`; `test_stale_version_conflict` → 409 and stored data unchanged.
  - `test_rename_validation`: titles of 0 and 121 characters are rejected.
  - `test_delete_owner_only`: editor → 403, stranger → 404.
  - `test_copy_creates_owned_board` for owner, editor and viewer.
  - `test_idor`: user B gets 404 on every endpoint for user A's unshared board.
  - `test_disabled_owner_board_unavailable` to sharees.
  - `test_limits`: board size → 413; 201st board → 403 with a limit code; storage quota → 403.
  - `test_rate_limit_writes` → 429.

**T4.3 Front end: cloud autosave and status**
- Current board `{id, version, permission}`; debounced save (~2 s) and save on `visibilitychange`;
  status indicator; retry with backoff; local cache kept.
- Done when (E2E):
  - `test_autosave_to_account`: draw, wait, reload `/b/<id>` in a fresh browser context → the stroke
    is there.
  - `test_saves_are_debounced`: 20 quick strokes → at most a few PUTs.
  - `test_offline_then_recover`: block network, draw → "Not saved"; unblock → "Saved", with nothing
    lost.
  - `test_board_style_and_history_persist`: style, undo history and replay survive the round trip.
  - Manual: on iPad, with quick Pencil strokes during autosave, no strokes are dropped and drawing
    doesn't stutter.

**T4.4 Front end: My boards panel and `/b/<id>` routing**
- Done when (E2E): `test_new_open_rename_delete_board`; `test_open_board_by_url`;
  `test_no_access_message` for an unshared id (and a sign-in link when signed out);
  `test_back_button_between_boards`.

**T4.5 Conflict dialog** (spec §6.4)
- Done when (E2E, two browser contexts on the same board): both edit and the second save shows the
  dialog; `Load their version`, `Keep mine as a copy` and `Overwrite` each lead to the expected
  server state, checked through the API.

**T4.6 Save local board to account**
- Done when (E2E): a local board with content → sign in → prompt → accept → the board is in My
  boards with identical content; declining uploads nothing (no POST observed).

## P5 — Sharing

**T5.1 Shares API**
- Done when:
  - `test_share_add_list_update_remove` (owner).
  - `test_share_non_owner_forbidden`: editor → 403, stranger → 404.
  - `test_share_with_unregistered_email`: once that person signs up, they see the board.
  - `test_share_invalid_email`, `test_share_with_self_rejected`,
    `test_share_duplicate_updates_permission`, `test_share_limit`.
  - `test_viewer_cannot_save_or_rename` → 403.
  - `test_leave_shared_board`.
  - `test_revoked_share_takes_effect_immediately`: the next GET → 404.
  - `test_email_case_insensitive` (`Bob@X.com` = `bob@x.com`).

**T5.2 Front end: share dialog + copy link**
- Done when (E2E): `test_owner_shares_board` → the second user sees it under "Shared with me" and
  can open it by link; `test_change_and_remove_share`.

**T5.3 Front end: view-only mode**
- Done when (E2E): `test_viewer_mode`: the editing tools are inert, drawing does nothing, and no
  PUT is sent; pan, zoom, replay and PDF export work; "Make a copy" opens an editable copy.
  Also `test_share_revoked_while_open`: the next save fails, the board turns view-only and a
  message is shown.

## P6 — Account self-service

**T6.1 Display name**: `PATCH /api/me`, plus Settings → Account UI.
- Done when: `test_display_name_update`, `test_display_name_validation` (empty → falls back to
  the Google name; max 80; control characters stripped); E2E `test_edit_display_name` shows the
  name in the menu and to sharees.

**T6.2 Sign out of all devices**
- Done when: `test_signout_all_invalidates_other_sessions` (two clients: both → 401 afterwards).

**T6.3 Export**
- Done when: `test_export_zip` contains one JSON per owned board, each passing the board
  validator, plus `account.json`; boards shared with the user are not included; E2E
  `test_export_download` downloads a file.

**T6.4 Delete account**
- Done when:
  - `test_delete_requires_matching_email` → 400 otherwise.
  - `test_delete_removes_user_boards_shares`: owned boards and their shares are gone, shares to the
    user's email are gone, and boards shared with them are untouched.
  - `test_delete_audit_entry_without_personal_data`.
  - `test_deleted_user_can_sign_up_fresh`: same Google account → a new, empty account.
  - E2E `test_delete_account_flow` ends signed out with the local board intact.

## P7 — Admin

**T7.1 Admin API**: list/search, role, status, sign out, delete, audit.
- Done when:
  - `test_admin_endpoints_require_admin`: user → 403, anonymous → 401.
  - `test_admin_list_search_paginate`; the response has **no** board titles or content.
  - `test_disable_enable_user`: a disabled user's session is rejected on its next request.
  - `test_promote_demote`.
  - `test_admin_signout_user` bumps the epoch.
  - `test_admin_delete_user` has the same effects as T6.4.
  - `test_last_admin_protected`: the only admin can't be demoted, disabled or deleted by anyone.
  - `test_admin_cannot_change_self`.
  - `test_every_admin_action_audited`, with actor, action and target.
  - `test_admin_cannot_read_unshared_board` → 404.

**T7.2 Admin console page** (`/admin`, admin.html + admin.js)
- Done when: `test_admin_page_hidden_from_users` (404 for user and anonymous, 200 for admin); E2E
  `test_admin_console`: search, disable, enable, promote and delete, each with a confirmation, and
  the audit view lists the actions.
  Manual: usable on iPad and at phone width.

## P8 — Launch

**T8.1 Privacy policy rewrite** (spec §11)
- Done when: privacy.html describes the server, the stored data, admin visibility, retention,
  export and deletion; it has been reviewed by the project owner and the OAuth consent screen links
  to it.

**T8.2 Deployment**: Procfile/gunicorn, env vars on the host, Postgres, migrations on release,
HTTPS, staging + production.
- Done when: `flask db upgrade` runs on release; `/healthz` → 200 (checks the DB); the staging e2e
  suite passes against the deployed URL.

**T8.3 Manual test pass before launch**

| # | Check | Chrome (PC) | Safari (iPad + Pencil) |
|---|---|---|---|
| 1 | Real Google sign-in and sign-out | ☐ | ☐ |
| 2 | Quick Pencil strokes, none dropped, while signed in and autosaving | — | ☐ |
| 3 | Board saves and reopens on the other device | ☐ | ☐ |
| 4 | Share to a second Google account; open by link; view-only works | ☐ | ☐ |
| 5 | Conflict dialog when both devices edit one board | ☐ | ☐ |
| 6 | Drive save/open still work while signed in | ☐ | ☐ |
| 7 | PDF export, replay video, board style | ☐ | ☐ |
| 8 | Export my data and delete account | ☐ | ☐ |
| 9 | Admin console: disable a test user, who is signed out on their device | ☐ | ☐ |
| 10 | No CSP errors in the console | ☐ | ☐ |

**T8.4 Move off GitHub Pages**
- Done when: a banner on the old site points to the new address and explains how to bring a board
  across; after the agreed transition period the Pages site is turned off.
