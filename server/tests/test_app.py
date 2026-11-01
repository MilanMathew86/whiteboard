"""T1.2 serving and config, T1.3 security headers, T8.2 health check."""

import re

import pytest

from chalkback import create_app
from chalkback.config import load_config
from chalkback.security import CSP

OLD_META_CSP = (
    "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.2.1/ "
    "https://accounts.google.com/gsi/client https://apis.google.com; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://www.googleapis.com "
    "https://accounts.google.com/gsi/ https://api.anthropic.com; frame-src https://accounts.google.com/gsi/ "
    "https://docs.google.com; object-src 'none'; base-uri 'self'; form-action 'none'"
)


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert b'<canvas id="canvas">' in r.data


def test_static_assets(client):
    js = client.get("/app.js")
    css = client.get("/style.css")
    assert js.status_code == 200 and "javascript" in js.content_type
    assert css.status_code == 200 and css.content_type.startswith("text/css")


def test_board_route_serves_app(client):
    r = client.get("/b/abc")
    assert r.status_code == 200 and r.mimetype == "text/html"
    # The same page, with relative URLs pointed back at the root.
    assert r.data.replace(b'\n  <base href="/">', b"", 1) == client.get("/").data
    assert b'<base href="/">' in r.data


def test_admin_html_not_served_directly(client):
    assert client.get("/admin.html").status_code == 404


def test_unknown_api_route_is_json_404(client):
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.get_json()["error"]["code"] == "not_found"


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.get_json() == {"ok": True}


@pytest.mark.parametrize("path", ["/", "/app.js", "/api/me", "/missing-page", "/api/missing"])
def test_security_headers(client, path):
    r = client.get(path)
    assert r.headers["Content-Security-Policy"] == CSP
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["Referrer-Policy"] == "same-origin"
    assert "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]


def _directives(policy):
    out = {}
    for part in policy.split(";"):
        words = part.split()
        if words:
            out[words[0]] = set(words[1:])
    return out


def test_csp_matches_previous_policy():
    old, new = _directives(OLD_META_CSP), _directives(CSP)
    for directive, sources in old.items():
        assert sources <= new[directive], directive


def test_index_has_no_meta_csp(client):
    # One source of truth: the header. A stale meta tag would silently tighten it.
    assert not re.search(rb'http-equiv="Content-Security-Policy"', client.get("/").data)


def test_no_hsts_in_dev(client):
    assert "Strict-Transport-Security" not in client.get("/").headers


def test_hsts_in_prod(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "x" * 40)
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost/db")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
    cfg = load_config("production")
    assert cfg.SQLALCHEMY_DATABASE_URI.startswith("postgresql+psycopg://")
    cfg.SQLALCHEMY_DATABASE_URI = "sqlite://"  # no PostgreSQL here; the check has already passed
    app = create_app(cfg)
    r = app.test_client().get("/app.js")
    assert "max-age" in r.headers["Strict-Transport-Security"]


@pytest.mark.parametrize("missing", ["SECRET_KEY", "DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])
def test_prod_requires_secrets(monkeypatch, missing):
    env = {"SECRET_KEY": "x" * 40, "DATABASE_URL": "postgresql://h/db", "GOOGLE_CLIENT_ID": "id",
           "GOOGLE_CLIENT_SECRET": "s"}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv(missing)
    with pytest.raises(RuntimeError, match=missing):
        load_config("production")


def test_prod_rejects_sqlite(monkeypatch):
    for k, v in {"SECRET_KEY": "x" * 40, "DATABASE_URL": "sqlite:///x.db", "GOOGLE_CLIENT_ID": "id",
                 "GOOGLE_CLIENT_SECRET": "s"}.items():
        monkeypatch.setenv(k, v)
    with pytest.raises(RuntimeError, match="SQLite"):
        load_config("production")


def test_prod_rejects_short_secret(monkeypatch):
    for k, v in {"SECRET_KEY": "short", "DATABASE_URL": "postgresql://h/db", "GOOGLE_CLIENT_ID": "id",
                 "GOOGLE_CLIENT_SECRET": "s"}.items():
        monkeypatch.setenv(k, v)
    with pytest.raises(RuntimeError, match="32"):
        load_config("production")


def test_unknown_env_rejected():
    with pytest.raises(RuntimeError, match="Unknown"):
        load_config("staging-typo")


def test_admin_emails_from_env(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", " A@x.com, b@y.com ,")
    assert {"a@x.com", "b@y.com"} == load_config("development").ADMIN_EMAILS


def test_test_login_absent_outside_testing(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite://")
    app = create_app("development")
    assert "/test/login" not in {r.rule for r in app.url_map.iter_rules()}
    assert app.test_client().post("/test/login", json={"email": "x@y.com"}).status_code in (404, 405)
