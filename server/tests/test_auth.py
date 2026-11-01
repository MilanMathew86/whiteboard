"""T3.2 Google sign-in and T3.3 /api/me."""

from urllib.parse import parse_qs, urlsplit

import pytest

from chalkback.extensions import db
from chalkback.models import User
from conftest import google_signin


def test_login_redirects_to_google(client, fake_google):
    r = client.get("/auth/login")
    assert r.status_code == 302
    url = urlsplit(r.headers["Location"])
    q = parse_qs(url.query)
    assert url.netloc == "accounts.google.com"
    assert q["state"][0] and q["nonce"][0]
    assert q["scope"] == ["openid email profile"]
    assert q["redirect_uri"] == ["http://localhost/auth/callback"]
    assert q["client_id"] == ["test-client.apps.googleusercontent.com"]


def test_callback_creates_user(client, fake_google):
    r = google_signin(client)
    assert r.status_code == 302 and r.headers["Location"] == "/?signedin=1"
    user = User.query.filter_by(google_sub="g-123").one()
    assert (user.email, user.google_name, user.role) == ("carol@example.com", "Carol", "user")
    assert user.last_login_at is not None
    me = client.get("/api/me").get_json()
    assert me["user"]["email"] == "carol@example.com" and me["csrfToken"]


def test_callback_checks_nonce(client, fake_google):
    r = client.get("/auth/login")
    nonce = parse_qs(urlsplit(r.headers["Location"]).query)["nonce"][0]
    state = parse_qs(urlsplit(r.headers["Location"]).query)["state"][0]
    client.get(f"/auth/callback?code=abc&state={state}")
    assert fake_google.nonces == [nonce]


def test_callback_updates_profile(client, fake_google):
    google_signin(client)
    fake_google.claims = {**fake_google.claims, "email": "Carol.New@Example.com", "name": "Carol N"}
    google_signin(client)
    users = User.query.all()
    assert len(users) == 1
    assert (users[0].email, users[0].google_name) == ("carol.new@example.com", "Carol N")


def test_callback_rejects_unverified_email(client, fake_google):
    fake_google.claims = {**fake_google.claims, "email_verified": False}
    r = google_signin(client)
    assert r.headers["Location"] == "/?signin=unverified"
    assert User.query.count() == 0
    assert client.get("/api/me").get_json() == {"user": None}


def test_callback_rejects_missing_claims(client, fake_google):
    fake_google.claims = {"email_verified": True}
    assert google_signin(client).headers["Location"] == "/?signin=failed"


def test_callback_rejects_bad_state(client, fake_google):
    client.get("/auth/login")
    r = client.get("/auth/callback?code=abc&state=forged")
    assert r.headers["Location"] == "/?signin=failed"
    assert fake_google.token_requests == 0  # never exchanged the code
    assert User.query.count() == 0


def test_callback_google_error(client, fake_google):
    client.get("/auth/login")
    r = client.get("/auth/callback?error=access_denied")
    assert r.headers["Location"] == "/?signin=failed"


def test_disabled_user_cannot_sign_in(client, fake_google):
    google_signin(client)
    client.post("/auth/logout")
    User.query.one().status = "disabled"
    db.session.commit()
    r = google_signin(client)
    assert r.headers["Location"] == "/?signin=disabled"
    assert client.get("/api/me").get_json() == {"user": None}


def test_admin_emails_bootstrap(client, fake_google):
    fake_google.claims = {**fake_google.claims, "email": "ADMIN@example.com"}
    google_signin(client)
    assert User.query.one().role == "admin"


def test_email_taken_over_by_new_google_account(client, fake_google):
    google_signin(client)
    fake_google.claims = {**fake_google.claims, "sub": "g-999"}  # same email, different Google account
    google_signin(client)
    old, new = User.query.order_by(User.id).all()
    assert new.email == "carol@example.com" and old.email.endswith("@replaced.invalid")


@pytest.mark.parametrize("next_path,expected", [
    ("/b/abc123", "/b/abc123?signedin=1"),
    ("/b/x?y=1", "/b/x?y=1&signedin=1"),
    ("https://evil.com", "/?signedin=1"),
    ("//evil.com", "/?signedin=1"),
    ("/\\evil.com", "/?signedin=1"),
    ("javascript:alert(1)", "/?signedin=1"),
    ("", "/?signedin=1"),
])
def test_next_param_local_only(client, fake_google, next_path, expected):
    from urllib.parse import quote
    assert google_signin(client, quote(next_path, safe="")).headers["Location"] == expected


def test_logout_clears_session(alice):
    assert alice.post("/auth/logout").status_code == 200
    assert alice.get("/api/me").get_json() == {"user": None}


def test_session_cookie_flags(app, fake_google):
    client = app.test_client()
    r = google_signin(client)
    cookie = r.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie
    assert app.config["SESSION_COOKIE_SECURE"] is False  # dev/test; production sets it (test_config)


def test_prod_cookie_secure():
    from chalkback.config import ProductionConfig
    assert ProductionConfig.SESSION_COOKIE_SECURE is True


def test_google_tokens_not_stored(app, client, fake_google):
    google_signin(client)
    with client.session_transaction() as s:
        assert set(s.keys()) <= {"uid", "epoch", "csrf", "_permanent"}
        assert "google-access" not in str(dict(s))
    for user in User.query.all():
        assert "google-access" not in str(vars(user)) and "google-id-token" not in str(vars(user))


def test_me_signed_in(alice):
    data = alice.get("/api/me").get_json()
    assert set(data["user"]) == {"id", "email", "name", "displayName", "googleName", "picture", "role"}
    assert "google_sub" not in str(data) and "sub-alice" not in str(data)


def test_signin_rate_limited(app, client, fake_google, limits_on):
    app.config["RATELIMIT_SIGNIN"] = "3 per minute"
    codes = [client.get("/auth/login").status_code for _ in range(4)]
    assert codes == [302, 302, 302, 429]
