"""Database tables (spec §5). Internal integer keys never leave the server; the API uses public_id."""

import secrets
from datetime import datetime, timezone

from sqlalchemy.orm import deferred

from .extensions import db

ROLES = ("user", "admin")
STATUSES = ("active", "disabled")
PERMISSIONS = ("view", "edit")


def new_public_id():
    return secrets.token_urlsafe(16)  # 22 URL-safe characters, 128 random bits


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    """ISO 8601 in UTC with a Z, for the API. SQLite drops time zones, so naive means UTC."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _enum_check(column, values, name):
    return db.CheckConstraint(f"{column} IN ({', '.join(repr(v) for v in values)})", name=name)


class User(db.Model):
    __tablename__ = "users"
    __table_args__ = (
        _enum_check("role", ROLES, "ck_users_role"),
        _enum_check("status", STATUSES, "ck_users_status"),
    )

    id = db.Column(db.Integer, primary_key=True)
    public_id = db.Column(db.String(32), unique=True, nullable=False, default=new_public_id)
    google_sub = db.Column(db.String(255), unique=True, nullable=False)
    email = db.Column(db.String(320), unique=True, nullable=False)
    google_name = db.Column(db.String(255))
    picture_url = db.Column(db.String(1024))
    display_name = db.Column(db.String(80))
    role = db.Column(db.String(10), nullable=False, default="user")
    status = db.Column(db.String(10), nullable=False, default="active")
    session_epoch = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    last_login_at = db.Column(db.DateTime(timezone=True))

    @property
    def name(self):
        return self.display_name or self.google_name or self.email

    @property
    def is_admin(self):
        return self.role == "admin"

    @property
    def is_active(self):
        return self.status == "active"


class Board(db.Model):
    __tablename__ = "boards"

    id = db.Column(db.Integer, primary_key=True)
    public_id = db.Column(db.String(32), unique=True, nullable=False, default=new_public_id)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = db.Column(db.String(120), nullable=False, default="Untitled board")
    # Deferred: board lists and limit checks shouldn't load megabytes of drawing.
    data = deferred(db.Column(db.Text, nullable=False))
    size_bytes = db.Column(db.Integer, nullable=False, default=0)
    version = db.Column(db.Integer, nullable=False, default=1)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    owner = db.relationship("User", lazy="joined")
    shares = db.relationship("BoardShare", back_populates="board", cascade="all, delete-orphan",
                             passive_deletes=True)


class BoardShare(db.Model):
    __tablename__ = "board_shares"
    __table_args__ = (
        db.UniqueConstraint("board_id", "email", name="uq_board_shares_board_email"),
        _enum_check("permission", PERMISSIONS, "ck_board_shares_permission"),
    )

    id = db.Column(db.Integer, primary_key=True)
    public_id = db.Column(db.String(32), unique=True, nullable=False, default=new_public_id)
    board_id = db.Column(db.Integer, db.ForeignKey("boards.id", ondelete="CASCADE"), nullable=False)
    # Shares are keyed by email, so a board can be shared before the person signs up.
    email = db.Column(db.String(320), nullable=False, index=True)
    permission = db.Column(db.String(10), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    board = db.relationship("Board", back_populates="shares")


class AuditLog(db.Model):
    __tablename__ = "audit_log"

    id = db.Column(db.Integer, primary_key=True)
    actor_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action = db.Column(db.String(40), nullable=False, index=True)
    target_type = db.Column(db.String(20), nullable=False)
    target_id = db.Column(db.String(32), nullable=False)
    details = db.Column(db.JSON, nullable=False, default=dict)  # never board content
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)

    actor = db.relationship("User", lazy="joined")


def audit(actor, action, target_type, target_id, **details):
    db.session.add(AuditLog(actor_id=actor.id if actor else None, action=action,
                            target_type=target_type, target_id=target_id, details=details))
