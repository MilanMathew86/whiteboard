"""T6 account self-service."""

import io
import json
import zipfile

import pytest

from chalkback.models import AuditLog, Board, BoardShare, User
from conftest import new_board


def test_display_name_update(alice, bob):
    r = alice.patch("/api/me", json={"displayName": "Professor A"})
    assert r.status_code == 200 and r.get_json()["user"]["name"] == "Professor A"
    board = new_board(alice)
    alice.post(f"/api/boards/{board['id']}/shares", json={"email": "bob@example.com", "permission": "view"})
    assert bob.get("/api/boards").get_json()["shared"][0]["owner"]["name"] == "Professor A"


@pytest.mark.parametrize("value,expected", [
    ("", "Alice"),           # empty falls back to the Google name
    ("   ", "Alice"),
    (None, "Alice"),
    ("A\x00l\x07i  ce", "Ali ce"),  # control characters stripped, spaces collapsed
])
def test_display_name_cleaning(alice, value, expected):
    r = alice.patch("/api/me", json={"displayName": value})
    assert r.status_code == 200 and r.get_json()["user"]["name"] == expected


@pytest.mark.parametrize("body", [{"displayName": "x" * 81}, {"displayName": 5}, {}])
def test_display_name_validation(alice, body):
    assert alice.patch("/api/me", json=body).status_code == 400


def test_signout_all_invalidates_other_sessions(app, alice):
    from conftest import Api
    second = app.test_client()
    with alice.client.session_transaction() as s:
        session_copy = dict(s)
    with second.session_transaction() as s:
        s.update(session_copy)  # the same account signed in on another device
    other = Api(second, alice.csrf)
    assert other.get("/api/boards").status_code == 200
    assert alice.post("/api/me/signout-all").status_code == 200
    assert alice.get("/api/boards").status_code == 401
    assert other.get("/api/boards").status_code == 401


def test_export_zip(alice, bob):
    a = new_board(alice, "Algebra notes", {"v": 2, "shapes": [], "pool": [], "assets": []})
    new_board(alice, "Geo/metry?")
    theirs = new_board(bob, "Bob's board")
    bob.post(f"/api/boards/{theirs['id']}/shares", json={"email": "alice@example.com", "permission": "view"})
    alice.post(f"/api/boards/{a['id']}/shares", json={"email": "bob@example.com", "permission": "edit"})

    r = alice.get("/api/me/export")
    assert r.status_code == 200 and r.mimetype == "application/zip"
    assert "attachment" in r.headers["Content-Disposition"]
    zf = zipfile.ZipFile(io.BytesIO(r.data))
    names = zf.namelist()
    board_files = [n for n in names if n.startswith("boards/")]
    assert len(board_files) == 2 and "account.json" in names
    assert any(n.startswith("boards/Algebra-notes-") for n in board_files)
    for n in board_files:
        assert json.loads(zf.read(n))["v"] == 2  # each one is a loadable board
    account = json.loads(zf.read("account.json"))
    assert account["profile"]["email"] == "alice@example.com"
    assert account["sharesGranted"] == [{"board": a["id"], "email": "bob@example.com", "permission": "edit"}]
    assert account["sharesReceived"][0]["owner"] == "bob@example.com"
    assert not any(theirs["id"] in n for n in names)  # boards shared with Alice aren't hers to export


def test_delete_requires_matching_email(alice):
    for body in ({}, {"confirmEmail": "bob@example.com"}, {"confirmEmail": 1}):
        r = alice.delete("/api/me", json=body)
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "confirm_mismatch"
    assert User.query.filter_by(email="alice@example.com").count() == 1


def test_delete_removes_user_boards_shares(alice, bob):
    mine = new_board(alice, "Mine")
    alice.post(f"/api/boards/{mine['id']}/shares", json={"email": "bob@example.com", "permission": "edit"})
    theirs = new_board(bob, "Bob's")
    bob.post(f"/api/boards/{theirs['id']}/shares", json={"email": "alice@example.com", "permission": "edit"})

    assert alice.delete("/api/me", json={"confirmEmail": " Alice@Example.com "}).status_code == 200
    assert User.query.filter_by(email="alice@example.com").count() == 0
    assert Board.query.filter_by(public_id=mine["id"]).count() == 0
    assert BoardShare.query.count() == 0  # both the share on her board and the share to her email
    assert bob.get(f"/api/boards/{theirs['id']}").status_code == 200  # Bob's board untouched
    assert alice.get("/api/me").get_json() == {"user": None}


def test_delete_audit_entry_without_personal_data(alice):
    uid = alice.user["id"]
    alice.delete("/api/me", json={"confirmEmail": "alice@example.com"})
    entry = AuditLog.query.one()
    assert (entry.action, entry.target_id, entry.actor_id) == ("account.delete", uid, None)
    assert "alice" not in json.dumps(entry.details).lower()


def test_deleted_user_can_sign_up_fresh(alice, signin):
    new_board(alice)
    alice.delete("/api/me", json={"confirmEmail": "alice@example.com"})
    again = signin("alice@example.com")
    assert again.user["id"] != alice.user["id"]
    assert again.get("/api/boards").get_json() == {"owned": [], "shared": []}


def test_last_admin_cannot_delete_self(admin):
    r = admin.delete("/api/me", json={"confirmEmail": "admin@example.com"})
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "last_admin"


def test_self_service_needs_sign_in(anon):
    assert anon.patch("/api/me", json={"displayName": "x"}).status_code == 401
    assert anon.get("/api/me/export").status_code == 401
    assert anon.delete("/api/me", json={}).status_code == 401
