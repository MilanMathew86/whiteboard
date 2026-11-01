# User management — specification

Status: draft for review · 2026-11-01
Related: [plan.md](plan.md) · [tasks.md](tasks.md)

## 1. Summary

ChalkBack today is static files on GitHub Pages: boards live in the browser (localStorage) or in the
user's own Google Drive, and there is no server or account. This feature adds a **Python Flask
server** with **Google sign-in** so that people can:

1. keep their boards in their **account** and open them on any device (e.g. iPad and PC);
2. **share** boards with other people, as viewers or editors;
3. manage their own account (**self-service**: display name, export, delete);
4. be managed by an **admin** (list, disable, change role, sign out, delete users).

Flask serves the front end and the API from one origin. GitHub Pages is retired once the server is
live.

## 2. Goals and non-goals

### Goals
- Sign in with a Google account; no passwords are stored by ChalkBack.
- Boards saved to the account, with the same file format as today's autosave/Drive save
  (board, undo history, replay and board style all survive).
- Sharing by email with *view* or *edit* permission, and share links that open a board directly.
- Users can export all their data and delete their account.
- Admins manage accounts without being able to read board content.
- Signed-out use keeps working exactly as today (local board, Drive save/open, PDF export, AI).

### Non-goals (this release)
- Real-time collaboration (two people seeing each other's strokes live). Concurrent edits are
  handled by conflict detection (§6.4), not merging.
- Email/password accounts, other identity providers, or organisations/teams.
- Public (anyone-with-the-link, no sign-in) sharing.
- Sending email notifications (sharing does not email the invitee).
- Native apps or offline-first sync beyond the existing local cache.

## 3. Users and roles

| Role | Who | Can |
|---|---|---|
| Guest | Not signed in | Everything the app does today, on a local board only |
| User | Signed in, status *active* | Guest abilities + own boards, sharing, self-service |
| Admin | User with role `admin` | User abilities + the admin console (§8) |

- **Status**: `active` or `disabled`. A disabled user cannot sign in, and any session they already
  have stops working on its next request.
- **First admin**: emails listed in the `ADMIN_EMAILS` environment variable become admins when they
  sign in. After that, admins promote others in the console.
- There must always be at least one active admin: the last one cannot be demoted, disabled or
  deleted (by themselves or anyone else).

## 4. Sign-in (Google, server-side)

- **Flow**: OpenID Connect authorisation-code flow handled by Flask (Authlib), with scopes
  `openid email profile`. The sign-in button is a link to `/auth/login`; Google redirects back to
  `/auth/callback`. This is a full-page redirect rather than a popup, so it's reliable in iPad Safari
  (no popup blocking, no third-party cookies).
- **Identity**: users are identified by Google's stable subject id (`sub`), not by email. Email,
  name and picture are refreshed from Google at every sign-in. Only verified emails are accepted
  (`email_verified = true`).
- **No Google tokens stored**: the server uses Google only to establish identity at sign-in and
  discards Google's tokens. Google Drive access stays exactly as today, client-side with the
  `drive.file` scope and a token held only in page memory.
- **Session**: a signed Flask session cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, lasting 30 days.
  It holds the user id, a *session epoch* and a CSRF token. Every request re-checks the user exists,
  is active, and that the epoch matches the user's current epoch; bumping the epoch signs the user
  out everywhere.
- **Sign-out**: `POST /auth/logout` clears the session cookie.
- **Return path**: `/auth/login?next=/b/<id>` returns the user to the board they were opening.
  `next` must be a local path; anything else is ignored.

## 5. Data model

All timestamps are UTC. Public ids are random and unguessable (e.g. 22-character URL-safe tokens);
database integer keys are never exposed.

**users**
| Field | Notes |
|---|---|
| id | internal key |
| public_id | exposed in the API |
| google_sub | unique, from Google |
| email | verified email from Google, lower-cased; unique |
| google_name, picture_url | from Google, refreshed at sign-in |
| display_name | optional; user-editable, max 80 characters; falls back to `google_name` |
| role | `user` or `admin` |
| status | `active` or `disabled` |
| session_epoch | integer; bumped to sign out everywhere |
| created_at, last_login_at | |

**boards**
| Field | Notes |
|---|---|
| id, public_id | |
| owner_id | → users |
| title | 1–120 characters; default "Untitled board" |
| data | the board JSON, same format as the autosave (v2) |
| size_bytes | length of `data` |
| version | integer, +1 on every content save (§6.4) |
| created_at, updated_at | |

**board_shares**
| Field | Notes |
|---|---|
| id, public_id | |
| board_id | → boards |
| email | invitee's email, lower-cased; unique per board |
| permission | `view` or `edit` |
| created_at | |

A share is keyed by **email**, so a board can be shared with someone who hasn't signed up yet. It
applies to whichever signed-in user has that verified email.

**audit_log**: id, actor_id (nullable once the actor is deleted), action, target_type, target_id,
details (small JSON, never board content), created_at. This records admin actions and account
deletions.

**Limits** (configurable)
| Limit | Default |
|---|---|
| Board size | 15 MB |
| Storage per user (owned boards) | 250 MB |
| Boards per user | 200 |
| Shares per board | 50 |
| Request body | 16 MB |

## 6. Boards

### 6.1 Access rules
| Action | Owner | Editor | Viewer | Admin (not otherwise shared) |
|---|---|---|---|---|
| Open / read content | ✓ | ✓ | ✓ | ✗ |
| Save content | ✓ | ✓ | ✗ | ✗ |
| Rename | ✓ | ✓ | ✗ | ✗ |
| Make a copy (into own account) | ✓ | ✓ | ✓ | ✗ |
| Manage shares | ✓ | ✗ | ✗ | ✗ |
| Delete | ✓ | ✗ | ✗ | ✗ |
| Leave (remove own share) | — | ✓ | ✓ | — |

- Boards owned by a **disabled** user can't be opened by anyone until the owner is re-enabled.
- A board the caller has no access to returns **404**, not 403, so its existence isn't revealed.

### 6.2 Board list ("My boards")
- Two sections: *My boards* and *Shared with me*, each sorted by last updated.
- Each entry shows title, owner (for shared ones), permission, last updated and size.
- Actions: open, new board, rename, make a copy, share (owner), delete (owner), leave (shared).

### 6.3 Opening and saving
- A board's address is `/b/<public_id>`. Flask serves the app there, and the app loads that board.
  The address is also the **share link**.
- Opening a board the user can't access shows "This board doesn't exist or isn't shared with you",
  plus a sign-in link when signed out.
- **Autosave**: while an account board is open with edit permission, changes are saved to the
  server about 2 s after the last change, and when the page is hidden. A status indicator shows
  *Saved*, *Saving…*, *Not saved — retrying* or *Offline*. Failed saves retry with backoff.
- The local autosave keeps working as a cache, so a refresh or a dropped connection doesn't lose
  work. When the page is reopened, a newer local copy is offered for saving.
- **View-only**: viewers can pan, zoom, replay and export the board, but the editing tools are
  disabled (the same mechanism as replay mode). "Make a copy" gives them an editable board of their
  own.
- **Moving a local board in**: after signing in, if the local board has content, the app offers
  "Save this board to your account". Nothing is uploaded without that click.
- Google Drive save/open still work. Opening a Drive file while an account board is open asks
  whether to replace that board's content.

### 6.4 Concurrent edits
- Every save sends the `version` it was based on. If the server's version has moved on (someone
  else saved), the save is rejected with **409 Conflict** and nothing is overwritten.
- The app then pauses autosave and offers: **Load their version** (discard local changes),
  **Keep mine as a copy** (save local content as a new board), or **Overwrite** (owner and editors,
  after confirmation).

### 6.5 Content validation on the server
- Saved data must be a JSON object within the size limit, with `v` of 1 or 2 and the top-level
  fields the app writes. Anything else is rejected with 422.
- The browser keeps validating every board strictly before use (the existing `validateBoard`),
  because shared boards can be written by other people.

## 7. Sharing

- The owner shares a board by entering an email address and choosing *view* or *edit*. The dialog
  lists current shares, where the permission can be changed or the share removed.
- Sharing with yourself, invalid emails, duplicates (which update the permission) and going over the
  share limit are all handled with clear messages.
- "Copy link" copies `/b/<public_id>`. The link only works for people the board is shared with.
- No email is sent; the owner passes the link on themselves.
- Removing a share takes effect on the invitee's next request. If they have the board open, their
  next save fails and the board turns view-only with a message.
- Deleting a board removes its shares.

## 8. Admin console

The admin console is a separate page, `/admin`, served only to admins (others get 404). It has
its own small script and the same styles as the app.

- **Users table**: name, email, role, status, number of boards, storage used, created, last
  sign-in. Search by name or email, 50 per page.
- **Actions per user** (each asks for confirmation and is written to the audit log):
  - Disable / enable
  - Make admin / remove admin
  - Sign out everywhere (bumps the session epoch)
  - Delete user (same effect as self-deletion, §9)
- **Guards**: admins can't disable, demote or delete themselves through the console, and the last
  active admin is protected (§3).
- **Audit log** view: newest first, filter by action.
- **Privacy**: admins see account metadata and sizes only, never board titles or content.

## 9. Account self-service

Account settings live in a new **Account** section of the Settings dialog when signed in.

- Shows the Google name, email and picture, plus an editable **display name** (shown to people the
  user shares with).
- **Sign out**, and **Sign out of all devices** (bumps the epoch).
- **Download my data**: a ZIP with one JSON file per owned board (the same format as a Drive save)
  plus `account.json` (profile, list of shares granted and received).
- **Delete account**: the user types their email to confirm. This deletes the user, their owned
  boards and the shares on them, and any shares that point to their email. Boards that were shared
  with them are unaffected. An audit entry records the deletion without personal data beyond the
  user's internal id.
- "Clear local data" keeps working as today and also signs out.

## 10. API

All endpoints return JSON. Errors look like `{"error": {"code": "...", "message": "..."}}`.
Requests that change data must send the `X-CSRF-Token` header (from `/api/me`) and come from this
site's origin (`Origin` header checked).

| Method & path | Who | Purpose |
|---|---|---|
| GET `/auth/login` | anyone | Start Google sign-in (`next` optional) |
| GET `/auth/callback` | Google | Finish sign-in |
| POST `/auth/logout` | user | Sign out |
| GET `/api/me` | anyone | `{user: null}` or profile + role + `csrfToken` |
| PATCH `/api/me` | user | Update display name |
| POST `/api/me/signout-all` | user | Bump epoch |
| GET `/api/me/export` | user | ZIP download |
| DELETE `/api/me` | user | Delete account (body: `{confirmEmail}`) |
| GET `/api/boards` | user | `{owned: [...], shared: [...]}` (metadata) |
| POST `/api/boards` | user | Create (`{title?, data?}`) |
| GET `/api/boards/<id>` | access | Metadata, permission, version, data |
| PUT `/api/boards/<id>` | edit | Save `{data, version}` → new version, or 409 |
| PATCH `/api/boards/<id>` | edit | Rename `{title}` |
| DELETE `/api/boards/<id>` | owner | Delete |
| POST `/api/boards/<id>/copy` | access | Copy into own account |
| GET `/api/boards/<id>/shares` | owner | List shares |
| POST `/api/boards/<id>/shares` | owner | Add or update `{email, permission}` |
| PATCH `/api/boards/<id>/shares/<sid>` | owner | Change permission |
| DELETE `/api/boards/<id>/shares/<sid>` | owner | Remove share |
| DELETE `/api/boards/<id>/shares/me` | invitee | Leave a shared board |
| GET `/api/admin/users` | admin | List / search (`q`, `page`) |
| PATCH `/api/admin/users/<uid>` | admin | `{role?, status?}` |
| POST `/api/admin/users/<uid>/signout` | admin | Bump epoch |
| DELETE `/api/admin/users/<uid>` | admin | Delete user |
| GET `/api/admin/audit` | admin | Audit log (`action`, `page`) |

Status codes: 400 bad input, 401 not signed in, 403 signed in but not allowed (and CSRF failures),
404 not found or no access, 409 version conflict, 413 too large, 422 invalid board data, 429 rate
limited.

## 11. Security and privacy requirements

- **Headers** (set by Flask on every response): the existing Content Security Policy moved from the
  `<meta>` tag into a header, with `frame-ancestors 'none'` added; `X-Content-Type-Options: nosniff`;
  `Referrer-Policy: same-origin`; HSTS in production.
- **CSRF**: token check plus `Origin` check on every state-changing request; `SameSite=Lax` cookie.
- **Authorisation** on every board endpoint: no endpoint trusts ids from the client without an
  access check.
- **Rate limits** (Flask-Limiter): sign-in 10/min per IP; writes 120/min per user; admin 60/min.
- **Secrets** come from environment variables only: `SECRET_KEY`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `DATABASE_URL`, `ADMIN_EMAILS`. The repo contains no secrets. The OAuth
  client secret is new and never reaches the browser.
- **Logging**: no board content, CSRF tokens or session cookies in logs.
- **Privacy policy**: privacy.html must be rewritten before launch. It currently says there is no
  server, account or database. The new version must say what the server stores (profile, boards,
  shares, audit), who can see it (admins: account metadata only), retention, and how to export or
  delete data. Google's OAuth consent screen needs the new scopes and redirect URIs.

## 12. Non-functional requirements

- Works in current Chrome, Edge, Firefox and Safari, including **iPad Safari with Apple Pencil**,
  with no regression in drawing.
- Opening a 5 MB board takes under 2 s on broadband. Autosave never blocks drawing.
- Production database: PostgreSQL. SQLite is used for development and tests. Most hosts' disks are
  wiped on redeploy, so SQLite is not used in production.
- Schema changes go through migrations (Flask-Migrate / Alembic).

## 13. Open questions

1. **Host and database provider** (e.g. Render, Railway or Fly.io, with managed Postgres). This
   decides the production config and cost.
2. **Retention**: are deleted accounts and boards removed immediately (as specified) or kept for N
   days for recovery?
3. Should board size and storage limits be shown to users up front, or only when they're reached?
4. Is the domain changing? Moving off GitHub Pages changes the site's origin, so local boards saved
   in browsers on the old address won't appear on the new one. Users must export or move them
   while both are live.
