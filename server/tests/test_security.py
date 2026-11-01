"""T3.1 sessions, guards, CSRF and Origin checks."""

from chalkback.extensions import db
from chalkback.models import User


def _user(email):
    return User.query.filter_by(email=email).one()


def test_anonymous_me_returns_null_user(anon):
    r = anon.get("/api/me")
    assert r.status_code == 200 and r.get_json() == {"user": None}


def test_signed_in_me(alice):
    assert alice.get("/api/me").get_json()["user"]["email"] == "alice@example.com"


def test_session_with_wrong_epoch_is_signed_out(alice):
    _user("alice@example.com").session_epoch += 1
    db.session.commit()
    assert alice.get("/api/me").get_json() == {"user": None}
    assert alice.get("/api/boards").status_code == 401


def test_disabled_user_session_rejected(alice):
    _user("alice@example.com").status = "disabled"
    db.session.commit()
    r = alice.get("/api/boards")
    assert r.status_code == 401
    # The session was cleared, so re-enabling doesn't bring it back.
    _user("alice@example.com").status = "active"
    db.session.commit()
    assert alice.get("/api/boards").status_code == 401


def test_deleted_user_session_rejected(alice):
    db.session.delete(_user("alice@example.com"))
    db.session.commit()
    assert alice.get("/api/boards").status_code == 401


def test_state_change_without_csrf_rejected(alice):
    r = alice.client.post("/api/boards", json={"title": "x"})
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "bad_csrf"


def test_wrong_csrf_rejected(alice):
    r = alice.post("/api/boards", json={"title": "x"}, headers={"X-CSRF-Token": "nope"})
    assert r.status_code == 403


def test_foreign_origin_rejected(alice):
    r = alice.post("/api/boards", json={"title": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "bad_origin"


def test_same_origin_accepted(alice):
    r = alice.post("/api/boards", json={"title": "x"}, headers={"Origin": "http://localhost"})
    assert r.status_code == 201


def test_get_requests_do_not_need_csrf(alice):
    assert alice.client.get("/api/boards").status_code == 200


def test_anonymous_write_is_401_not_403(anon):
    r = anon.post("/api/boards", json={"title": "x"})
    assert r.status_code == 401 and r.get_json()["error"]["code"] == "signed_out"


def test_logout_needs_same_origin(alice):
    r = alice.post("/auth/logout", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert alice.get("/api/me").get_json()["user"] is not None


def test_api_responses_not_cached(alice):
    assert alice.get("/api/me").headers["Cache-Control"] == "no-store"
