"""The signed-in user's own account (spec §9)."""

from flask import Blueprint, g, jsonify, send_file, session

from ..extensions import db
from ..models import iso, utcnow
from ..security import ApiError, bump_epoch, login_required
from ..services.accounts import clean_display_name, delete_user, export_zip, user_json
from . import json_body, writes_limited

bp = Blueprint("me", __name__, url_prefix="/api/me")


@bp.get("")
def me():
    if g.user is None:
        return jsonify(user=None)
    return jsonify(user=user_json(g.user), csrfToken=session["csrf"])


@bp.patch("")
@writes_limited
@login_required
def update_me():
    body = json_body()
    if "displayName" not in body:
        raise ApiError(400, "bad_request", "Nothing to change")
    g.user.display_name = clean_display_name(body["displayName"])
    db.session.commit()
    return jsonify(user=user_json(g.user))


@bp.post("/signout-all")
@writes_limited
@login_required
def signout_all():
    bump_epoch(g.user)
    db.session.commit()
    session.clear()
    return jsonify(ok=True)


@bp.get("/export")
@login_required
def export():
    stamp = iso(utcnow())[:10]
    return send_file(export_zip(g.user), mimetype="application/zip", as_attachment=True,
                     download_name=f"chalkback-export-{stamp}.zip", max_age=0)


@bp.delete("")
@writes_limited
@login_required
def delete_me():
    confirm = json_body().get("confirmEmail")
    if not isinstance(confirm, str) or confirm.strip().lower() != g.user.email:
        raise ApiError(400, "confirm_mismatch", "Type your email address exactly to confirm")
    delete_user(g.user)
    session.clear()
    return jsonify(ok=True)
