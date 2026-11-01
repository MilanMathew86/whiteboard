"""T2.1 data model."""

import re

import pytest
from sqlalchemy.exc import IntegrityError

from chalkback.extensions import db
from chalkback.models import Board, BoardShare, User, iso, new_public_id


def _user(sub, email):
    u = User(google_sub=sub, email=email)
    db.session.add(u)
    return u


def test_user_unique_sub_and_email(app):
    _user("s1", "a@x.com")
    db.session.commit()
    _user("s1", "b@x.com")
    with pytest.raises(IntegrityError):
        db.session.commit()
    db.session.rollback()
    _user("s2", "a@x.com")
    with pytest.raises(IntegrityError):
        db.session.commit()


def test_role_and_status_constrained(app):
    u = _user("s1", "a@x.com")
    u.role = "superuser"
    with pytest.raises(IntegrityError):
        db.session.commit()


def test_share_unique_per_board_email(app):
    u = _user("s1", "a@x.com")
    db.session.flush()
    b = Board(owner_id=u.id, data="{}")
    db.session.add(b)
    db.session.flush()
    db.session.add(BoardShare(board_id=b.id, email="b@x.com", permission="view"))
    db.session.commit()
    db.session.add(BoardShare(board_id=b.id, email="b@x.com", permission="edit"))
    with pytest.raises(IntegrityError):
        db.session.commit()


def test_public_ids_random_and_unique():
    ids = {new_public_id() for _ in range(1000)}
    assert len(ids) == 1000
    assert all(len(i) >= 22 and re.fullmatch(r"[A-Za-z0-9_-]+", i) for i in ids)


def test_cascade_delete_board_removes_shares(app):
    u = _user("s1", "a@x.com")
    db.session.flush()
    b = Board(owner_id=u.id, data="{}")
    db.session.add(b)
    db.session.flush()
    db.session.add(BoardShare(board_id=b.id, email="b@x.com", permission="view"))
    db.session.commit()
    db.session.delete(b)
    db.session.commit()
    assert BoardShare.query.count() == 0


def test_database_cascade_on_user_delete(app):
    # The database itself cascades (not just the ORM), so raw deletes can't strand rows.
    u = _user("s1", "a@x.com")
    db.session.flush()
    db.session.add(Board(owner_id=u.id, data="{}"))
    db.session.commit()
    db.session.execute(db.delete(User).where(User.id == u.id))
    db.session.commit()
    assert Board.query.count() == 0


def test_user_name_fallbacks(app):
    u = User(google_sub="s", email="a@x.com")
    assert u.name == "a@x.com"
    u.google_name = "Ann"
    assert u.name == "Ann"
    u.display_name = "Annie"
    assert u.name == "Annie"


def test_iso_formats_utc():
    from datetime import datetime, timedelta, timezone
    assert iso(None) is None
    assert iso(datetime(2026, 1, 2, 3, 4, 5)) == "2026-01-02T03:04:05Z"
    assert iso(datetime(2026, 1, 2, 8, 4, 5, tzinfo=timezone(timedelta(hours=5)))) == "2026-01-02T03:04:05Z"
