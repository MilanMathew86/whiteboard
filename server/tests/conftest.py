import json
from pathlib import Path

import pytest

from chalkback import create_app
from chalkback.auth import google
from chalkback.config import load_config
from chalkback.extensions import db, limiter

FIXTURES = Path(__file__).parent / "fixtures"

GOOGLE_METADATA = {
    "issuer": "https://accounts.google.com",
    "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_endpoint": "https://oauth2.googleapis.com/token",
    "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
    "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
    "_loaded_at": 1e12,  # tells Authlib not to fetch the discovery document
}


def make_app(**overrides):
    cfg = load_config("testing")
    for key, value in overrides.items():
        setattr(cfg, key, value)
    app = create_app(cfg)
    google_client = app.extensions["chalkback_google"]
    google_client.server_metadata.update(GOOGLE_METADATA)
    return app


@pytest.fixture
def app():
    app = make_app()
    with app.app_context():
        db.create_all()
        yield app
        db.session.remove()
        db.drop_all()


@pytest.fixture
def client(app):
    return app.test_client()


class Api:
    """A test client for one browser: remembers the CSRF token and sends it on writes."""

    def __init__(self, client, csrf=None, user=None):
        self.client = client
        self.csrf = csrf
        self.user = user

    def _write(self, method, path, json=None, headers=None, **kw):
        h = {"X-CSRF-Token": self.csrf} if self.csrf else {}
        h.update(headers or {})
        return self.client.open(path, method=method, json=json, headers=h, **kw)

    def get(self, path, **kw):
        return self.client.get(path, **kw)

    def post(self, path, json=None, **kw):
        return self._write("POST", path, json, **kw)

    def put(self, path, json=None, **kw):
        return self._write("PUT", path, json, **kw)

    def patch(self, path, json=None, **kw):
        return self._write("PATCH", path, json, **kw)

    def delete(self, path, json=None, **kw):
        return self._write("DELETE", path, json, **kw)


@pytest.fixture
def signin(app):
    """signin(email, role=None) → an Api for a new browser signed in as that user."""

    def _signin(email="alice@example.com", role=None, name=None):
        c = app.test_client()
        body = {"email": email}
        if role:
            body["role"] = role
        if name:
            body["name"] = name
        r = c.post("/test/login", json=body)
        assert r.status_code == 200, r.get_json()
        data = r.get_json()
        return Api(c, data["csrfToken"], data["user"])

    return _signin


@pytest.fixture
def alice(signin):
    return signin("alice@example.com")


@pytest.fixture
def bob(signin):
    return signin("bob@example.com")


@pytest.fixture
def admin(signin):
    return signin("admin@example.com")  # in TestingConfig.ADMIN_EMAILS


@pytest.fixture
def anon(client):
    return Api(client)


@pytest.fixture
def fake_google(app, monkeypatch):
    """Stand in for Google's token endpoint and ID-token check; Authlib's state check stays real.

    Set `fake.claims` before the callback. `fake.nonces` records the nonce the callback checked.
    """
    client = google()

    class Fake:
        claims = {"sub": "g-123", "email": "carol@example.com", "email_verified": True, "name": "Carol",
                  "picture": "https://lh3.googleusercontent.com/a/carol"}
        nonces = []
        token_requests = 0

    def fetch_access_token(**params):
        Fake.token_requests += 1
        return {"access_token": "google-access", "id_token": "google-id-token", "token_type": "Bearer",
                "expires_in": 3600}

    def parse_id_token(token, nonce, **kwargs):
        Fake.nonces.append(nonce)
        return dict(Fake.claims)

    monkeypatch.setattr(client, "fetch_access_token", fetch_access_token)
    monkeypatch.setattr(client, "parse_id_token", parse_id_token)
    return Fake


def google_signin(client, next_path=None):
    """Run the sign-in redirect dance against the fake; returns the final callback response."""
    r = client.get("/auth/login" + (f"?next={next_path}" if next_path else ""))
    assert r.status_code == 302
    from urllib.parse import parse_qs, urlsplit
    state = parse_qs(urlsplit(r.headers["Location"]).query)["state"][0]
    return client.get(f"/auth/callback?code=abc&state={state}")


@pytest.fixture
def limits_on(app):
    """Start rate-limit tests from zero; the test then lowers the limit it checks."""
    limiter.reset()
    yield
    limiter.reset()


def fixture_board(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def new_board(api, title="Board", data=None):
    body = {"title": title}
    if data is not None:
        body["data"] = data
    r = api.post("/api/boards", json=body)
    assert r.status_code == 201, r.get_json()
    return r.get_json()["board"]
