"""Admin console API (spec §8). Admins see account metadata and sizes, never board titles or content."""

from flask import Blueprint, g, jsonify, request
from sqlalchemy import func, or_

from ..extensions import db
from ..models import ROLES, STATUSES, AuditLog, Board, User, audit, iso
from ..security import ApiError, admin_required, bump_epoch
from ..services.accounts import delete_user, guard_last_admin
from . import admin_limited, json_body

bp = Blueprint("admin", __name__, url_prefix="/api/admin")

PAGE_SIZE = 50


def _page():
    try:
        return max(1, int(request.args.get("page", 1)))
    except ValueError:
        return 1


def _target(user_id):
    user = User.query.filter_by(public_id=user_id).first()
    if user is None:
        raise ApiError(404, "not_found", "That user doesn't exist")
    if user.id == g.user.id:
        raise ApiError(403, "self", "You can't change your own account from the admin console")
    return user


@bp.get("/users")
@admin_required
def list_users():
    stats = (db.session.query(Board.owner_id, func.count(Board.id).label("boards"),
                              func.coalesce(func.sum(Board.size_bytes), 0).label("bytes"))
             .group_by(Board.owner_id).subquery())
    q = (db.session.query(User, func.coalesce(stats.c.boards, 0), func.coalesce(stats.c.bytes, 0))
         .outerjoin(stats, stats.c.owner_id == User.id))
    term = request.args.get("q", "").strip().lower()
    if term:
        # Search text is matched literally: % and _ are escaped rather than used as wildcards.
        like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        q = q.filter(or_(*(func.lower(col).like(like, escape="\\")
                           for col in (User.email, User.google_name, User.display_name))))
    total = q.count()
    page = _page()
    rows = q.order_by(User.created_at.desc(), User.id.desc()).offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).all()
    return jsonify(
        users=[{
            "id": u.public_id, "email": u.email, "name": u.name, "role": u.role, "status": u.status,
            "boards": boards, "storage": int(size), "createdAt": iso(u.created_at), "lastLoginAt": iso(u.last_login_at),
            "isYou": u.id == g.user.id,
        } for u, boards, size in rows],
        page=page, pages=max(1, -(-total // PAGE_SIZE)), total=total,
    )


@bp.patch("/users/<user_id>")
@admin_limited
@admin_required
def update_user(user_id):
    user = _target(user_id)
    body = json_body()
    role, status = body.get("role"), body.get("status")
    if role is None and status is None:
        raise ApiError(400, "bad_request", "Nothing to change")
    if role is not None and role not in ROLES:
        raise ApiError(400, "bad_role", "Role must be user or admin")
    if status is not None and status not in STATUSES:
        raise ApiError(400, "bad_status", "Status must be active or disabled")
    if role == "user" and user.is_admin:
        guard_last_admin(user, "remove")
    if status == "disabled":
        guard_last_admin(user, "disable")

    if role is not None and role != user.role:
        audit(g.user, "user.role", "user", user.public_id, old=user.role, new=role)
        user.role = role
    if status is not None and status != user.status:
        audit(g.user, "user.status", "user", user.public_id, old=user.status, new=status)
        user.status = status
        if status == "disabled":
            bump_epoch(user)  # their open sessions end on the next request
    db.session.commit()
    return jsonify(ok=True, role=user.role, status=user.status)


@bp.post("/users/<user_id>/signout")
@admin_limited
@admin_required
def sign_out_user(user_id):
    user = _target(user_id)
    bump_epoch(user)
    audit(g.user, "user.signout", "user", user.public_id)
    db.session.commit()
    return jsonify(ok=True)


@bp.delete("/users/<user_id>")
@admin_limited
@admin_required
def remove_user(user_id):
    delete_user(_target(user_id), actor=g.user)
    return jsonify(ok=True)


@bp.get("/audit")
@admin_required
def audit_log():
    q = AuditLog.query
    action = request.args.get("action", "").strip()
    if action:
        q = q.filter(AuditLog.action == action)
    total = q.count()
    page = _page()
    entries = q.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).offset((page - 1) * PAGE_SIZE) \
        .limit(PAGE_SIZE).all()
    targets = {u.public_id: u.email for u in
               User.query.filter(User.public_id.in_([e.target_id for e in entries])).all()}
    return jsonify(
        entries=[{
            "id": e.id, "action": e.action, "actor": e.actor.email if e.actor else None,
            "targetType": e.target_type, "target": e.target_id, "targetEmail": targets.get(e.target_id),
            "details": e.details, "createdAt": iso(e.created_at),
        } for e in entries],
        page=page, pages=max(1, -(-total // PAGE_SIZE)), total=total,
    )
