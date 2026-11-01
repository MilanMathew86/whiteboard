"""Boards saved to an account (spec §6)."""

from flask import Blueprint, g, jsonify

from ..extensions import db
from ..models import Board, BoardShare, utcnow
from ..security import ApiError, login_required
from ..services.boards import board_meta, check_title, create_board, get_board, save_board
from ..validation import EMPTY_BOARD, validate_board
from . import json_body, writes_limited

bp = Blueprint("boards", __name__, url_prefix="/api/boards")


@bp.get("")
@login_required
def list_boards():
    owned = Board.query.filter_by(owner_id=g.user.id).order_by(Board.updated_at.desc()).all()
    shared = (Board.query.join(BoardShare).filter(BoardShare.email == g.user.email)
              .order_by(Board.updated_at.desc()).add_columns(BoardShare.permission).all())
    return jsonify(
        owned=[board_meta(b, "owner") for b in owned],
        shared=[board_meta(b, perm) for b, perm in shared if b.owner.is_active and b.owner_id != g.user.id],
    )


@bp.post("")
@writes_limited
@login_required
def create():
    body = json_body()
    title = check_title(body.get("title", "Untitled board"))
    text = validate_board(body.get("data", EMPTY_BOARD))
    board = create_board(g.user, title, text)
    return jsonify(board=board_meta(board, "owner")), 201


@bp.get("/<board_id>")
@login_required
def get(board_id):
    board, perm = get_board(board_id, g.user)
    return jsonify(board=board_meta(board, perm), data=board.data)


@bp.put("/<board_id>")
@writes_limited
@login_required
def save(board_id):
    board, _ = get_board(board_id, g.user, need="edit")
    body = json_body()
    version = body.get("version")
    if type(version) is not int:
        raise ApiError(400, "bad_request", "Missing the board version")
    if "data" not in body:
        raise ApiError(400, "bad_request", "Missing the board data")
    board = save_board(board, validate_board(body["data"]), version)
    return jsonify(version=board.version, updatedAt=board_meta(board, None)["updatedAt"])


@bp.patch("/<board_id>")
@writes_limited
@login_required
def rename(board_id):
    board, perm = get_board(board_id, g.user, need="edit")
    board.title = check_title(json_body().get("title"))
    board.updated_at = utcnow()
    db.session.commit()
    return jsonify(board=board_meta(board, perm))


@bp.delete("/<board_id>")
@writes_limited
@login_required
def delete(board_id):
    board, _ = get_board(board_id, g.user, need="owner")
    db.session.delete(board)
    db.session.commit()
    return jsonify(ok=True)


@bp.post("/<board_id>/copy")
@writes_limited
@login_required
def copy(board_id):
    board, _ = get_board(board_id, g.user)
    title = json_body().get("title") or f"Copy of {board.title}"
    copy = create_board(g.user, check_title(title[:120]), board.data)
    return jsonify(board=board_meta(copy, "owner")), 201
