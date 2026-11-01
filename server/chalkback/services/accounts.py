"""Signing users in, deleting accounts, exports and admin guards (spec §3, §4, §8, §9)."""

import io
import json
import re
import zipfile

from flask import current_app

from ..extensions import db
from ..models import AuditLog, Board, BoardShare, User, audit, iso, utcnow
from ..security import ApiError


def user_json(user):
    return {
        "id": user.public_id,
        "email": user.email,
        "name": user.name,
        "displayName": user.display_name,
        "googleName": user.google_name,
        "picture": user.picture_url,
        "role": user.role,
    }


def sign_in_user(claims):
    """Find or create the user for verified Google claims and refresh their profile.

    Returns the user, or None if their account is disabled.
    """
    email = claims["email"].strip().lower()
    user = User.query.filter_by(google_sub=claims["sub"]).first()
    if user is None:
        # A different Google account may have held this email before (rare): free it up.
        stale = User.query.filter_by(email=email).first()
        if stale is not None:
            stale.email = f"{stale.public_id}@replaced.invalid"
            db.session.flush()
        user = User(google_sub=claims["sub"], email=email, role="user", status="active", session_epoch=0)
        db.session.add(user)
    elif user.email != email:
        clash = User.query.filter(User.email == email, User.id != user.id).first()
        if clash is not None:
            clash.email = f"{clash.public_id}@replaced.invalid"
            db.session.flush()
        user.email = email
    user.google_name = (claims.get("name") or "")[:255] or None
    user.picture_url = (claims.get("picture") or "")[:1024] or None
    if email in current_app.config["ADMIN_EMAILS"]:
        user.role = "admin"
    if not user.is_active:
        db.session.commit()
        return None
    user.last_login_at = utcnow()
    db.session.commit()
    return user


_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def clean_display_name(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ApiError(400, "bad_name", "The name must be text")
    value = " ".join(_CONTROL.sub("", value).split())
    if len(value) > 80:
        raise ApiError(400, "bad_name", "Names can be at most 80 characters")
    return value or None  # empty falls back to the Google name


def active_admin_count():
    return User.query.filter_by(role="admin", status="active").count()


def guard_last_admin(user, action):
    """Refuse to leave the site without an active admin."""
    if user.is_admin and user.is_active and active_admin_count() <= 1:
        raise ApiError(409, "last_admin", f"You can't {action} the only admin — make someone else an admin first")


def delete_user(user, actor=None):
    """Delete the user, their boards (with those boards' shares) and every share to their email.

    Boards other people shared with them are left alone. `actor` is the admin doing it, or None
    when the user deletes themselves.
    """
    guard_last_admin(user, "delete")
    owned = Board.query.filter_by(owner_id=user.id).all()
    for board in owned:
        db.session.delete(board)  # cascades to its shares
    BoardShare.query.filter_by(email=user.email).delete()
    AuditLog.query.filter_by(actor_id=user.id).update({"actor_id": None})
    target = user.public_id
    db.session.delete(user)
    db.session.flush()
    if actor is None:
        audit(None, "account.delete", "user", target, boards=len(owned))
    else:
        audit(actor, "user.delete", "user", target, boards=len(owned))
    db.session.commit()


def _safe_name(title):
    name = re.sub(r"[^\w\- ]+", "", title).strip().replace(" ", "-")[:60]
    return name or "board"


def export_zip(user):
    """A ZIP of the user's own boards (one JSON each, like a Drive save) plus account.json."""
    buf = io.BytesIO()
    owned = Board.query.filter_by(owner_id=user.id).order_by(Board.created_at).all()
    granted = (BoardShare.query.join(Board).filter(Board.owner_id == user.id)
               .order_by(BoardShare.created_at).all())
    received = (BoardShare.query.join(Board).filter(BoardShare.email == user.email)
                .order_by(BoardShare.created_at).all())
    account = {
        "profile": {**user_json(user), "createdAt": iso(user.created_at), "lastLoginAt": iso(user.last_login_at)},
        "boards": [{"id": b.public_id, "title": b.title, "file": f"boards/{_safe_name(b.title)}-{b.public_id}.json",
                    "createdAt": iso(b.created_at), "updatedAt": iso(b.updated_at)} for b in owned],
        "sharesGranted": [{"board": s.board.public_id, "email": s.email, "permission": s.permission}
                          for s in granted],
        "sharesReceived": [{"board": s.board.public_id, "title": s.board.title, "owner": s.board.owner.email,
                            "permission": s.permission} for s in received],
    }
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("account.json", json.dumps(account, indent=2))
        for b in owned:
            zf.writestr(f"boards/{_safe_name(b.title)}-{b.public_id}.json", b.data)
    buf.seek(0)
    return buf
