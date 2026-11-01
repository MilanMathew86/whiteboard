"""T7.1 admin API and T7.2 admin page access."""

import json

import pytest

from chalkback.models import AuditLog, Board, User
from conftest import new_board


def uid(email):
    return User.query.filter_by(email=email).one().public_id


@pytest.mark.parametrize("method,path,body", [
    ("get", "/api/admin/users", None),
    ("patch", "/api/admin/users/x", {"role": "admin"}),
    ("post", "/api/admin/users/x/signout", None),
    ("delete", "/api/admin/users/x", None),
    ("get", "/api/admin/audit", None),
])
def test_admin_endpoints_require_admin(alice, anon, method, path, body):
    kw = {"json": body} if body is not None else {}
    assert getattr(alice, method)(path, **kw).status_code == 403
    assert getattr(anon, method)(path, **kw).status_code == 401


def test_admin_list_search_paginate(admin, signin):
    for i in range(55):
        signin(f"user{i:02}@example.com")
    alice = signin("alice@example.com", name="Alice Liddell")
    new_board(alice, "Secret plans", {"v": 2, "shapes": [], "pool": [], "assets": ["x" * 100]})

    page1 = admin.get("/api/admin/users").get_json()
    assert page1["total"] == 57 and page1["pages"] == 2 and len(page1["users"]) == 50
    page2 = admin.get("/api/admin/users?page=2").get_json()
    assert len(page2["users"]) == 7
    assert admin.get("/api/admin/users?page=abc").get_json()["page"] == 1

    found = admin.get("/api/admin/users?q=liddell").get_json()["users"]
    assert [u["email"] for u in found] == ["alice@example.com"]
    assert found[0]["boards"] == 1 and found[0]["storage"] > 100
    assert admin.get("/api/admin/users?q=ALICE@").get_json()["total"] == 1
    assert admin.get("/api/admin/users?q=%25").get_json()["total"] == 0  # wildcards are literal

    everything = json.dumps(page1) + json.dumps(page2) + json.dumps(found)
    assert "Secret plans" not in everything and "xxxx" not in everything  # no titles or content


def test_disable_enable_user(admin, alice):
    r = admin.patch(f"/api/admin/users/{uid('alice@example.com')}", json={"status": "disabled"})
    assert r.status_code == 200 and r.get_json()["status"] == "disabled"
    assert alice.get("/api/boards").status_code == 401
    admin.patch(f"/api/admin/users/{uid('alice@example.com')}", json={"status": "active"})
    assert User.query.filter_by(email="alice@example.com").one().status == "active"


def test_promote_demote(admin, alice):
    target = uid("alice@example.com")
    admin.patch(f"/api/admin/users/{target}", json={"role": "admin"})
    assert alice.get("/api/admin/users").status_code == 200
    admin.patch(f"/api/admin/users/{target}", json={"role": "user"})
    assert alice.get("/api/admin/users").status_code == 403


@pytest.mark.parametrize("body", [{}, {"role": "root"}, {"status": "banned"}])
def test_update_validation(admin, alice, body):
    assert admin.patch(f"/api/admin/users/{uid('alice@example.com')}", json=body).status_code == 400


def test_admin_signout_user(admin, alice):
    assert admin.post(f"/api/admin/users/{uid('alice@example.com')}/signout").status_code == 200
    assert alice.get("/api/me").get_json() == {"user": None}


def test_admin_delete_user(admin, alice, bob):
    board = new_board(alice)
    alice.post(f"/api/boards/{board['id']}/shares", json={"email": "bob@example.com", "permission": "edit"})
    theirs = new_board(bob)
    bob.post(f"/api/boards/{theirs['id']}/shares", json={"email": "alice@example.com", "permission": "edit"})
    assert admin.delete(f"/api/admin/users/{uid('alice@example.com')}").status_code == 200
    assert User.query.filter_by(email="alice@example.com").count() == 0
    assert Board.query.filter_by(public_id=board["id"]).count() == 0
    assert bob.get("/api/boards").get_json()["shared"] == []
    assert bob.get(f"/api/boards/{theirs['id']}").status_code == 200
    assert alice.get("/api/me").get_json() == {"user": None}


def test_last_admin_protected(admin, signin):
    # Through the console an admin can't touch themselves; the only other path is self-deletion.
    me = uid("admin@example.com")
    assert admin.patch(f"/api/admin/users/{me}", json={"role": "user"}).status_code == 403
    assert admin.delete("/api/me", json={"confirmEmail": "admin@example.com"}).status_code == 409
    # With two admins, either can remove the other, which leaves one protected admin again.
    other = signin("second@example.com", role="admin")
    assert other.patch(f"/api/admin/users/{me}", json={"role": "user"}).status_code == 200
    assert other.delete("/api/me", json={"confirmEmail": "second@example.com"}).status_code == 409


def test_last_admin_guard_in_service(app, admin):
    from chalkback.security import ApiError
    from chalkback.services.accounts import guard_last_admin
    with pytest.raises(ApiError):
        guard_last_admin(User.query.filter_by(email="admin@example.com").one(), "disable")


def test_admin_cannot_change_self(admin):
    me = uid("admin@example.com")
    for call in (lambda: admin.patch(f"/api/admin/users/{me}", json={"status": "disabled"}),
                 lambda: admin.post(f"/api/admin/users/{me}/signout"),
                 lambda: admin.delete(f"/api/admin/users/{me}")):
        r = call()
        assert r.status_code == 403 and r.get_json()["error"]["code"] == "self"


def test_unknown_user_404(admin):
    assert admin.patch("/api/admin/users/nobody", json={"role": "admin"}).status_code == 404


def test_every_admin_action_audited(admin, alice, bob):
    a, b = uid("alice@example.com"), uid("bob@example.com")
    admin.patch(f"/api/admin/users/{a}", json={"role": "admin", "status": "disabled"})
    admin.post(f"/api/admin/users/{a}/signout")
    admin.delete(f"/api/admin/users/{b}")
    actions = [(e.action, e.target_id, e.actor.email) for e in AuditLog.query.order_by(AuditLog.id)]
    assert actions == [
        ("user.role", a, "admin@example.com"),
        ("user.status", a, "admin@example.com"),
        ("user.signout", a, "admin@example.com"),
        ("user.delete", b, "admin@example.com"),
    ]
    log = admin.get("/api/admin/audit").get_json()
    assert [e["action"] for e in log["entries"]] == ["user.delete", "user.signout", "user.status", "user.role"]
    assert log["entries"][1]["targetEmail"] == "alice@example.com"
    filtered = admin.get("/api/admin/audit?action=user.role").get_json()["entries"]
    assert [e["details"] for e in filtered] == [{"old": "user", "new": "admin"}]


def test_no_audit_for_no_op(admin, alice):
    admin.patch(f"/api/admin/users/{uid('alice@example.com')}", json={"role": "user"})
    assert AuditLog.query.count() == 0


def test_admin_cannot_read_unshared_board(admin, alice):
    board = new_board(alice)
    assert admin.get(f"/api/boards/{board['id']}").status_code == 404


def test_admin_page_hidden_from_users(admin, alice, anon):
    assert anon.get("/admin").status_code == 404
    assert alice.get("/admin").status_code == 404
    r = admin.get("/admin")
    assert r.status_code == 200 and b"admin.js" in r.data


def test_admin_rate_limit(app, admin, alice, limits_on):
    app.config["RATELIMIT_ADMIN"] = "2 per minute"
    target = uid("alice@example.com")
    codes = [admin.post(f"/api/admin/users/{target}/signout").status_code for _ in range(3)]
    assert codes == [200, 200, 429]
