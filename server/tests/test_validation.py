"""T4.1 board validation. The fixtures are real saves made by the app (see fixtures/make_fixtures.py)."""

import json

import pytest

from conftest import fixture_board, new_board

FIXTURES = ["v1.json", "v2-drawing.json", "v2-image-style.json"]


@pytest.mark.parametrize("name", FIXTURES)
def test_validation_accepts_real_saves(alice, name):
    data = fixture_board(name)
    board = new_board(alice, data=data)
    stored = alice.get(f"/api/boards/{board['id']}").get_json()["data"]
    assert json.loads(stored) == data


def test_fixtures_cover_the_format():
    drawing = fixture_board("v2-drawing.json")
    styled = fixture_board("v2-image-style.json")
    types = {s["type"] for s in drawing["pool"]}
    assert {"pen", "rect", "text"} <= types and drawing["undo"]
    assert styled["assets"] and styled["paper"]["bg"] != "white"


@pytest.mark.parametrize("data,what", [
    ([], "not an object"),
    ("board", "not an object"),
    ({"v": 3, "shapes": []}, "unknown version"),
    ({"v": True, "shapes": [], "pool": [], "assets": []}, "unknown version"),
    ({"v": 2, "shapes": [], "pool": [], "assets": [], "extra": 1}, "unexpected field"),
    ({"v": 2, "shapes": [], "pool": []}, "missing"),
    ({"v": 2, "shapes": {}, "pool": [], "assets": []}, "shapes must be a list"),
    ({"v": 2, "shapes": [], "pool": [], "assets": [1]}, "images must be strings"),
    ({"v": 2, "shapes": [], "pool": [], "assets": [], "view": []}, "view must be an object"),
    ({"shapes": [], "paper": {}}, "unexpected field"),
])
def test_validation_rejects(alice, data, what):
    r = alice.post("/api/boards", json={"title": "x", "data": data})
    assert r.status_code == 422
    assert what in r.get_json()["error"]["message"]


def test_invalid_json_body(alice):
    board = new_board(alice)
    r = alice.client.put(f"/api/boards/{board['id']}", data="{not json",
                         headers={"X-CSRF-Token": alice.csrf, "Content-Type": "application/json"})
    assert r.status_code == 400


def test_board_too_large(app, alice):
    app.config["BOARD_MAX_BYTES"] = 1000
    data = {"v": 2, "shapes": [], "pool": [], "assets": ["data:image/png;base64," + "A" * 2000]}
    r = alice.post("/api/boards", json={"title": "x", "data": data})
    assert r.status_code == 413 and r.get_json()["error"]["code"] == "board_too_large"


def test_request_body_too_large(app, alice):
    app.config["MAX_CONTENT_LENGTH"] = 1000
    r = alice.post("/api/boards", json={"title": "x" * 2000})
    assert r.status_code == 413 and r.get_json()["error"]["code"] == "too_large"
