"""Who may do what with a board (spec §6.1), limits, and versioned saves (§6.4)."""

from flask import current_app
from sqlalchemy import func, update

from ..extensions import db
from ..models import Board, BoardShare, iso, utcnow
from ..security import ApiError

LEVELS = {"view": 1, "edit": 2, "owner": 3}


def permission_for(board, user):
    """'owner', 'edit', 'view' or None."""
    if board.owner_id == user.id:
        return "owner"
    if not board.owner.is_active:
        return None  # a disabled owner's boards are closed to everyone else
    share = BoardShare.query.filter_by(board_id=board.id, email=user.email).first()
    return share.permission if share else None


def get_board(public_id, user, need="view"):
    """The board and the user's permission, or 404 (no access, so as not to reveal it) / 403."""
    board = Board.query.filter_by(public_id=public_id).first()
    perm = permission_for(board, user) if board else None
    if perm is None:
        raise ApiError(404, "not_found", "This board doesn't exist or isn't shared with you")
    if LEVELS[perm] < LEVELS[need]:
        raise ApiError(403, "forbidden", "You can only view this board" if perm == "view"
                       else "Only the board's owner can do that")
    return board, perm


def board_meta(board, perm):
    return {
        "id": board.public_id,
        "title": board.title,
        "permission": perm,
        "owner": {"name": board.owner.name, "email": board.owner.email},
        "version": board.version,
        "size": board.size_bytes,
        "createdAt": iso(board.created_at),
        "updatedAt": iso(board.updated_at),
    }


def check_title(title):
    if not isinstance(title, str) or not title.strip():
        raise ApiError(400, "bad_title", "Give the board a name")
    title = " ".join(title.split())
    if len(title) > 120:
        raise ApiError(400, "bad_title", "Board names can be at most 120 characters")
    return title


def storage_used(user, excluding=None):
    q = db.session.query(func.coalesce(func.sum(Board.size_bytes), 0)).filter(Board.owner_id == user.id)
    if excluding is not None:
        q = q.filter(Board.id != excluding.id)
    return q.scalar()


def check_storage(user, size, replacing=None):
    """The owner must stay within their storage quota (owned boards only)."""
    if storage_used(user, excluding=replacing) + size > current_app.config["USER_STORAGE_BYTES"]:
        raise ApiError(403, "storage_full", "Your account storage is full — delete some boards to make room")


def create_board(user, title, text):
    if Board.query.filter_by(owner_id=user.id).count() >= current_app.config["MAX_BOARDS_PER_USER"]:
        raise ApiError(403, "too_many_boards", "You've reached the maximum number of boards")
    size = len(text.encode())
    check_storage(user, size)
    board = Board(owner_id=user.id, title=title, data=text, size_bytes=size)
    db.session.add(board)
    db.session.commit()
    return board


def save_board(board, text, version):
    """Save new content if `version` is still current, else 409 with the current version."""
    size = len(text.encode())
    check_storage(board.owner, size, replacing=board)
    # One conditional UPDATE, so two simultaneous saves of the same version can't both win.
    result = db.session.execute(
        update(Board)
        .where(Board.id == board.id, Board.version == version)
        .values(data=text, size_bytes=size, version=Board.version + 1, updated_at=utcnow())
    )
    if result.rowcount != 1:
        db.session.rollback()
        db.session.refresh(board)
        raise ApiError(409, "conflict", "Someone else saved this board since you opened it",
                       version=board.version)
    db.session.commit()
    db.session.refresh(board)
    return board
