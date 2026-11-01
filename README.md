# ChalkBack whiteboard

An infinite-canvas whiteboard for the browser (pen, shapes, text, images, replay, PDF export, Google
Drive, AI helpers) with optional accounts: sign in with Google to keep boards in your account, open
them on any device, share them, and manage users as an admin.

- `web/` — the app (plain HTML/CSS/JS, no build step). It still works as static files, signed out.
- `server/chalkback/` — the Flask server: serves `web/` and the account, boards, sharing and admin API.
- `docs/user-management/` — the [spec](docs/user-management/spec.md), [plan](docs/user-management/plan.md)
  and [tasks](docs/user-management/tasks.md) for accounts.

## Run it locally

```sh
python -m venv .venv
.venv/Scripts/activate            # Windows; on macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env              # then fill in GOOGLE_CLIENT_SECRET (and ADMIN_EMAILS for yourself)
flask --app chalkback db upgrade  # creates instance/dev.db
flask --app chalkback run         # http://localhost:5000
```

Google sign-in needs `http://localhost:5000/auth/callback` among the OAuth client's authorised redirect
URIs. Without a client secret everything except signing in still works.

To try it on a tablet on the same network: `flask --app chalkback run --host 0.0.0.0`. Google only allows
sign-in from `localhost` or HTTPS addresses, so test sign-in on the tablet against a deployed (HTTPS) copy.

## Tests

```sh
pytest                                                  # server tests, with coverage (≥ 90% required)
pytest server/e2e --browser chromium --browser webkit   # browser tests (first: python -m playwright install)
ruff check server
```

Set `TEST_DATABASE_URL=postgresql://…` to also run the migration tests against PostgreSQL (CI does).
`server/tests/fixtures/make_fixtures.py` regenerates the board fixtures by drawing in the real app.

## Deploy

Any host that runs a Python web process with PostgreSQL. The `Procfile` runs migrations on release and
serves the app with gunicorn. Set the variables in `.env.example`, with `CHALKBACK_ENV=production`; the
server refuses to start without a secret key, a Google client and a PostgreSQL database. Production
expects HTTPS (secure cookies, HSTS) behind the host's proxy. With more than one worker, point
`RATELIMIT_STORAGE_URI` at Redis so rate limits are shared.

Database changes: edit `server/chalkback/models.py`, then `flask --app chalkback db migrate -m "…"`, review
the generated file in `server/migrations/versions/`, and commit it.
