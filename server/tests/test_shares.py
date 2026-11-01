"""T5.1 sharing API."""

import pytest

from conftest import new_board


def shares_url(board):
    return f"/api/boards/{board['id']}/shares"


def test_share_add_list_update_remove(alice, bob):
    board = new_board(alice)
    r = alice.post(shares_url(board), json={"email": "bob@example.com", "permission": "view"})
    assert r.status_code == 201
    share = r.get_json()["share"]
    assert (share["email"], share["permission"], share["name"]) == ("bob@example.com", "view", "Bob")

    listed = alice.get(shares_url(board)).get_json()["shares"]
    assert [s["id"] for s in listed] == [share["id"]]

    r = alice.patch(f"{shares_url(board)}/{share['id']}", json={"permission": "edit"})
    assert r.get_json()["share"]["permission"] == "edit"
    assert bob.get("/api/boards").get_json()["shared"][0]["permission"] == "edit"

    assert alice.delete(f"{shares_url(board)}/{share['id']}").status_code == 200
    assert alice.get(shares_url(board)).get_json()["shares"] == []


def test_share_non_owner_forbidden(alice, bob, signin):
    board = new_board(alice)
    alice.post(shares_url(board), json={"email": "bob@example.com", "permission": "edit"})
    eve = signin("eve@example.com")
    assert bob.get(shares_url(board)).status_code == 403
    assert bob.post(shares_url(board), json={"email": "x@y.com", "permission": "edit"}).status_code == 403
    assert eve.get(shares_url(board)).status_code == 404


def test_share_with_unregistered_email(alice, signin):
    board = new_board(alice)
    r = alice.post(shares_url(board), json={"email": "new@example.com", "permission": "edit"})
    assert r.get_json()["share"]["name"] is None
    newcomer = signin("new@example.com")
    assert [b["id"] for b in newcomer.get("/api/boards").get_json()["shared"]] == [board["id"]]
    assert newcomer.get(f"/api/boards/{board['id']}").status_code == 200


@pytest.mark.parametrize("email", ["", "no-at-sign", "a@b", "a b@c.com", None, 42, "x" * 400 + "@y.com"])
def test_share_invalid_email(alice, email):
    board = new_board(alice)
    r = alice.post(shares_url(board), json={"email": email, "permission": "view"})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "bad_email"


def test_share_invalid_permission(alice):
    board = new_board(alice)
    r = alice.post(shares_url(board), json={"email": "b@x.com", "permission": "owner"})
    assert r.status_code == 400


def test_share_with_self_rejected(alice):
    board = new_board(alice)
    r = alice.post(shares_url(board), json={"email": "Alice@Example.com", "permission": "edit"})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "share_with_self"


def test_share_duplicate_updates_permission(alice):
    board = new_board(alice)
    alice.post(shares_url(board), json={"email": "b@x.com", "permission": "view"})
    r = alice.post(shares_url(board), json={"email": "B@X.com", "permission": "edit"})
    assert r.status_code == 200
    shares = alice.get(shares_url(board)).get_json()["shares"]
    assert [(s["email"], s["permission"]) for s in shares] == [("b@x.com", "edit")]


def test_share_limit(app, alice):
    app.config["MAX_SHARES_PER_BOARD"] = 2
    board = new_board(alice)
    for i in range(2):
        alice.post(shares_url(board), json={"email": f"p{i}@x.com", "permission": "view"})
    r = alice.post(shares_url(board), json={"email": "p9@x.com", "permission": "view"})
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "too_many_shares"


def test_viewer_cannot_save_or_rename(alice, bob):
    board = new_board(alice)
    alice.post(shares_url(board), json={"email": "bob@example.com", "permission": "view"})
    data = {"v": 2, "shapes": [], "pool": [], "assets": []}
    assert bob.get(f"/api/boards/{board['id']}").get_json()["board"]["permission"] == "view"
    assert bob.put(f"/api/boards/{board['id']}", json={"data": data, "version": 1}).status_code == 403
    assert bob.patch(f"/api/boards/{board['id']}", json={"title": "x"}).status_code == 403


def test_leave_shared_board(alice, bob):
    board = new_board(alice)
    alice.post(shares_url(board), json={"email": "bob@example.com", "permission": "view"})
    assert bob.delete(f"{shares_url(board)}/me").status_code == 200
    assert bob.get(f"/api/boards/{board['id']}").status_code == 404
    assert alice.delete(f"{shares_url(board)}/me").status_code == 400  # owners delete instead


def test_revoked_share_takes_effect_immediately(alice, bob):
    board = new_board(alice)
    share = alice.post(shares_url(board), json={"email": "bob@example.com", "permission": "edit"}).get_json()
    assert bob.get(f"/api/boards/{board['id']}").status_code == 200
    alice.delete(f"{shares_url(board)}/{share['share']['id']}")
    assert bob.get(f"/api/boards/{board['id']}").status_code == 404
    data = {"v": 2, "shapes": [], "pool": [], "assets": []}
    assert bob.put(f"/api/boards/{board['id']}", json={"data": data, "version": 1}).status_code == 404


def test_email_case_insensitive(alice, signin):
    board = new_board(alice)
    alice.post(shares_url(board), json={"email": "Bob@X.com", "permission": "view"})
    bob = signin("bob@x.com")
    assert bob.get(f"/api/boards/{board['id']}").status_code == 200


def test_unknown_share_404(alice):
    board = new_board(alice)
    assert alice.patch(f"{shares_url(board)}/nope", json={"permission": "edit"}).status_code == 404
    assert alice.delete(f"{shares_url(board)}/nope").status_code == 404


def test_share_ids_scoped_to_board(alice):
    a = new_board(alice)
    b = new_board(alice)
    share = alice.post(shares_url(a), json={"email": "x@y.com", "permission": "view"}).get_json()["share"]
    assert alice.delete(f"{shares_url(b)}/{share['id']}").status_code == 404
