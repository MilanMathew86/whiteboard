"""Server-side checks on board data (spec §6.5).

The browser validates every board strictly before using it (validateBoard in app.js), because
shared boards can be written by other people. The server checks the overall shape and size so
the database only ever holds something that looks like a ChalkBack board.
"""

import json

from flask import current_app

from .security import ApiError

V2_REQUIRED = {"v", "shapes", "pool", "assets"}
V2_OPTIONAL = {"view", "paper", "undo", "redo"}
V1_REQUIRED = {"shapes"}
V1_OPTIONAL = {"view"}

EMPTY_BOARD = {"v": 2, "shapes": [], "pool": [], "assets": []}


def _invalid(what):
    raise ApiError(422, "invalid_board", f"That isn't valid board data ({what})")


def _fields(data, required, optional):
    keys = set(data)
    if unexpected := keys - required - optional:
        _invalid(f"unexpected field {sorted(unexpected)[0]!r}")
    if missing := required - keys:
        _invalid(f"missing {sorted(missing)[0]!r}")


def _list(data, key):
    if key in data and not isinstance(data[key], list):
        _invalid(f"{key} must be a list")


def validate_board(data):
    """Check board data from a request and return it serialised for storage."""
    if not isinstance(data, dict):
        _invalid("not an object")
    v = data.get("v")
    if v == 2 and type(v) is int:
        _fields(data, V2_REQUIRED, V2_OPTIONAL)
        for key in ("shapes", "pool", "assets", "undo", "redo"):
            _list(data, key)
        if not all(isinstance(a, str) for a in data["assets"]):
            _invalid("images must be strings")
    elif "v" not in data:
        _fields(data, V1_REQUIRED, V1_OPTIONAL)
        _list(data, "shapes")
    else:
        _invalid("unknown version")
    for key in ("view", "paper"):
        if key in data and not isinstance(data[key], dict):
            _invalid(f"{key} must be an object")

    text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    if len(text.encode()) > current_app.config["BOARD_MAX_BYTES"]:
        raise ApiError(413, "board_too_large", "This board is too large to save")
    return text
