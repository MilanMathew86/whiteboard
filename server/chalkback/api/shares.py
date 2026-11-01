"""Sharing a board with other people by email (spec §7)."""

import re

from flask import Blueprint, current_app, g, jsonify

from ..extensions import db
from ..models import PERMISSIONS, BoardShare, User, iso
from ..security import ApiError, login_required
from ..services.boards import get_board
from . import json_body, writes_limited

bp = Blueprint("shares", __name__, url_prefix="/api/boards/<board_id>/shares")

EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")


def share_json(share):
    user = User.query.filter_by(email=share.email).first()
    return {
        "id": share.public_id,
        "email": share.email,
        "name": user.name if user else None,  # None until they've signed up
        "permission": share.permission,
        "createdAt": iso(share.created_at),
    }


def _permission(value):
    if value not in PERMISSIONS:
        raise ApiError(400, "bad_permission", "Choose view or edit")
    return value


def _share(board, share_id):
    share = BoardShare.query.filter_by(board_id=board.id, public_id=share_id).first()
    if share is None:
        raise ApiError(404, "not_found", "That share doesn't exist")
    return share


@bp.get("")
@login_required
def list_shares(board_id):
    board, _ = get_board(board_id, g.user, need="owner")
    shares = BoardShare.query.filter_by(board_id=board.id).order_by(BoardShare.created_at).all()
    return jsonify(shares=[share_json(s) for s in shares])


@bp.post("")
@writes_limited
@login_required
def add_share(board_id):
    board, _ = get_board(board_id, g.user, need="owner")
    body = json_body()
    email = body.get("email")
    if not isinstance(email, str) or len(email.strip()) > 320 or not EMAIL.match(email.strip()):
        raise ApiError(400, "bad_email", "Enter a valid email address")
    email = email.strip().lower()
    permission = _permission(body.get("permission"))
    if email == g.user.email:
        raise ApiError(400, "share_with_self", "You already own this board")

    share = BoardShare.query.filter_by(board_id=board.id, email=email).first()
    if share is not None:
        share.permission = permission  # sharing again just changes the permission
        status = 200
    else:
        if BoardShare.query.filter_by(board_id=board.id).count() >= current_app.config["MAX_SHARES_PER_BOARD"]:
            raise ApiError(403, "too_many_shares", "This board is shared with as many people as it can be")
        share = BoardShare(board_id=board.id, email=email, permission=permission)
        db.session.add(share)
        status = 201
    db.session.commit()
    return jsonify(share=share_json(share)), status


@bp.delete("/me")
@writes_limited
@login_required
def leave(board_id):
    board, perm = get_board(board_id, g.user)
    if perm == "owner":
        raise ApiError(400, "owner_cannot_leave", "You own this board — delete it instead")
    BoardShare.query.filter_by(board_id=board.id, email=g.user.email).delete()
    db.session.commit()
    return jsonify(ok=True)


@bp.patch("/<share_id>")
@writes_limited
@login_required
def update_share(board_id, share_id):
    board, _ = get_board(board_id, g.user, need="owner")
    share = _share(board, share_id)
    share.permission = _permission(json_body().get("permission"))
    db.session.commit()
    return jsonify(share=share_json(share))


@bp.delete("/<share_id>")
@writes_limited
@login_required
def remove_share(board_id, share_id):
    board, _ = get_board(board_id, g.user, need="owner")
    db.session.delete(_share(board, share_id))
    db.session.commit()
    return jsonify(ok=True)
