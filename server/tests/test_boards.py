"""T4.2 boards API."""

import json

import pytest

from chalkback.extensions import db
from chalkback.models import User
from conftest import new_board

DATA = {"v": 2, "shapes": [0], "pool": [{"type": "pen", "color": "#1e1e1e", "size": 4,
                                         "points": [{"x": 1, "y": 2}]}], "assets": []}


def share(owner, board_id, email, permission="edit"):
    r = owner.post(f"/api/boards/{board_id}/shares", json={"email": email, "permission": permission})
    assert r.status_code in (200, 201), r.get_json()


def test_create_and_get_roundtrip(alice):
    board = new_board(alice, "Physics", DATA)
    assert board["title"] == "Physics" and board["permission"] == "owner" and board["version"] == 1
    r = alice.get(f"/api/boards/{board['id']}").get_json()
    assert json.loads(r["data"]) == DATA
    assert r["board"]["size"] == len(r["data"].encode())


def test_create_defaults(alice):
    board = new_board(alice, title="Untitled board")
    data = json.loads(alice.get(f"/api/boards/{board['id']}").get_json()["data"])
    assert data == {"v": 2, "shapes": [], "pool": [], "assets": []}


def test_list_owned_and_shared(alice, bob):
    mine = new_board(alice, "Mine")
    theirs = new_board(bob, "Bob's")
    share(bob, theirs["id"], "alice@example.com", "view")
    data = alice.get("/api/boards").get_json()
    assert [b["id"] for b in data["owned"]] == [mine["id"]]
    assert [(b["id"], b["permission"]) for b in data["shared"]] == [(theirs["id"], "view")]
    assert data["shared"][0]["owner"]["email"] == "bob@example.com"
    assert "data" not in json.dumps(data["owned"] + data["shared"]).replace('"updatedAt"', "")


def test_save_increments_version(alice):
    board = new_board(alice)
    r = alice.put(f"/api/boards/{board['id']}", json={"data": DATA, "version": 1})
    assert r.status_code == 200 and r.get_json()["version"] == 2
    assert json.loads(alice.get(f"/api/boards/{board['id']}").get_json()["data"]) == DATA


def test_stale_version_conflict(alice, bob):
    board = new_board(alice)
    share(alice, board["id"], "bob@example.com", "edit")
    assert bob.put(f"/api/boards/{board['id']}", json={"data": DATA, "version": 1}).status_code == 200
    r = alice.put(f"/api/boards/{board['id']}", json={"data": {**DATA, "shapes": []}, "version": 1})
    assert r.status_code == 409
    assert r.get_json()["error"]["code"] == "conflict" and r.get_json()["version"] == 2
    assert json.loads(alice.get(f"/api/boards/{board['id']}").get_json()["data"]) == DATA  # unchanged


@pytest.mark.parametrize("body", [{"data": DATA}, {"version": 1}, {"data": DATA, "version": "1"}])
def test_save_requires_data_and_version(alice, body):
    board = new_board(alice)
    assert alice.put(f"/api/boards/{board['id']}", json=body).status_code == 400


def test_rename(alice):
    board = new_board(alice)
    r = alice.patch(f"/api/boards/{board['id']}", json={"title": "  New   name "})
    assert r.status_code == 200 and r.get_json()["board"]["title"] == "New name"


@pytest.mark.parametrize("title", ["", "   ", "x" * 121, None, 5])
def test_rename_validation(alice, title):
    board = new_board(alice)
    assert alice.patch(f"/api/boards/{board['id']}", json={"title": title}).status_code == 400


def test_editor_can_rename_viewer_cannot(alice, bob, signin):
    board = new_board(alice)
    share(alice, board["id"], "bob@example.com", "edit")
    share(alice, board["id"], "vic@example.com", "view")
    vic = signin("vic@example.com")
    assert bob.patch(f"/api/boards/{board['id']}", json={"title": "By Bob"}).status_code == 200
    assert vic.patch(f"/api/boards/{board['id']}", json={"title": "By Vic"}).status_code == 403


def test_delete_owner_only(alice, bob, signin):
    board = new_board(alice)
    share(alice, board["id"], "bob@example.com", "edit")
    stranger = signin("eve@example.com")
    assert bob.delete(f"/api/boards/{board['id']}").status_code == 403
    assert stranger.delete(f"/api/boards/{board['id']}").status_code == 404
    assert alice.delete(f"/api/boards/{board['id']}").status_code == 200
    assert alice.get(f"/api/boards/{board['id']}").status_code == 404


@pytest.mark.parametrize("permission", ["owner", "edit", "view"])
def test_copy_creates_owned_board(alice, bob, permission):
    board = new_board(alice, "Original", DATA)
    copier = alice
    if permission != "owner":
        share(alice, board["id"], "bob@example.com", permission)
        copier = bob
    r = copier.post(f"/api/boards/{board['id']}/copy")
    assert r.status_code == 201
    copy = r.get_json()["board"]
    assert copy["title"] == "Copy of Original" and copy["permission"] == "owner"
    assert copy["owner"]["email"] == copier.user["email"]
    assert json.loads(copier.get(f"/api/boards/{copy['id']}").get_json()["data"]) == DATA


def test_idor(alice, bob):
    board = new_board(alice)
    bid = board["id"]
    calls = [
        bob.get(f"/api/boards/{bid}"),
        bob.put(f"/api/boards/{bid}", json={"data": DATA, "version": 1}),
        bob.patch(f"/api/boards/{bid}", json={"title": "x"}),
        bob.delete(f"/api/boards/{bid}"),
        bob.post(f"/api/boards/{bid}/copy"),
        bob.get(f"/api/boards/{bid}/shares"),
        bob.post(f"/api/boards/{bid}/shares", json={"email": "bob@example.com", "permission": "edit"}),
        bob.delete(f"/api/boards/{bid}/shares/me"),
    ]
    assert [c.status_code for c in calls] == [404] * len(calls)


def test_unknown_board_404(alice):
    assert alice.get("/api/boards/doesnotexist").status_code == 404


def test_disabled_owner_board_unavailable(alice, bob):
    board = new_board(alice)
    share(alice, board["id"], "bob@example.com", "edit")
    User.query.filter_by(email="alice@example.com").one().status = "disabled"
    db.session.commit()
    assert bob.get(f"/api/boards/{board['id']}").status_code == 404
    assert bob.get("/api/boards").get_json()["shared"] == []


def test_boards_need_sign_in(anon):
    assert anon.get("/api/boards").status_code == 401


def test_limit_board_count(app, alice):
    app.config["MAX_BOARDS_PER_USER"] = 2
    new_board(alice)
    new_board(alice)
    r = alice.post("/api/boards", json={"title": "third"})
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "too_many_boards"


def test_limit_storage(app, alice):
    app.config["USER_STORAGE_BYTES"] = 400
    board = new_board(alice, data={"v": 2, "shapes": [], "pool": [], "assets": ["x" * 150]})
    big = {"v": 2, "shapes": [], "pool": [], "assets": ["x" * 300]}
    r = alice.post("/api/boards", json={"title": "big", "data": big})
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "storage_full"
    # Replacing a board's content only counts the new size, not old + new.
    assert alice.put(f"/api/boards/{board['id']}", json={"data": big, "version": 1}).status_code == 200


def test_rate_limit_writes(app, alice, limits_on):
    app.config["RATELIMIT_WRITES"] = "3 per minute"
    codes = [alice.post("/api/boards", json={"title": "x"}).status_code for _ in range(4)]
    assert codes == [201, 201, 201, 429]
    assert alice.get("/api/boards").status_code == 200  # reads aren't limited
    assert alice.post("/api/boards", json={"title": "x"}).get_json()["error"]["code"] == "rate_limited"
