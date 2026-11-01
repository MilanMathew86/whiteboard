"""T2.2 migrations: upgrade, downgrade, upgrade, and no drift from the models.

Runs on SQLite always, and on PostgreSQL when TEST_DATABASE_URL is set (CI does this).
"""

import os

import pytest
from flask_migrate import downgrade, upgrade
from sqlalchemy import create_engine, inspect

from chalkback import create_app
from chalkback.config import load_config
from chalkback.extensions import db

TABLES = {"users", "boards", "board_shares", "audit_log", "alembic_version"}


def _targets(tmp_path):
    urls = [("sqlite", f"sqlite:///{tmp_path / 'mig.db'}")]
    pg = os.environ.get("TEST_DATABASE_URL")
    if pg:
        urls.append(("postgres", pg.replace("postgresql://", "postgresql+psycopg://", 1)))
    return urls


@pytest.fixture(params=["sqlite", "postgres"])
def migration_app(request, tmp_path):
    urls = dict(_targets(tmp_path))
    if request.param not in urls:
        pytest.skip("set TEST_DATABASE_URL to run against PostgreSQL")
    cfg = load_config("testing")
    cfg.SQLALCHEMY_DATABASE_URI = urls[request.param]
    app = create_app(cfg)
    with app.app_context():
        db.drop_all()
        engine = create_engine(urls[request.param])
        with engine.begin() as conn:
            conn.exec_driver_sql("DROP TABLE IF EXISTS alembic_version")
        yield app
        downgrade(revision="base")
        db.session.remove()


def test_migration_upgrade_downgrade(migration_app):
    upgrade()
    assert set(inspect(db.engine).get_table_names()) >= TABLES
    downgrade(revision="base")
    assert set(inspect(db.engine).get_table_names()) <= {"alembic_version"}
    upgrade()
    assert set(inspect(db.engine).get_table_names()) >= TABLES


def test_models_match_migrations(migration_app):
    """The same check as `flask db check`: autogenerate finds nothing to change."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    upgrade()
    with db.engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), db.metadata)
    assert diff == []
