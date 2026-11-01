from flask import g, request
from flask_limiter import Limiter
from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event
from sqlalchemy.engine import Engine


def _limit_key():
    """Signed-in users are limited per account, everyone else per IP address."""
    user = g.get("user")
    return f"user:{user.id}" if user else f"ip:{request.remote_addr}"


db = SQLAlchemy()
migrate = Migrate()
limiter = Limiter(key_func=_limit_key)


@event.listens_for(Engine, "connect")
def _sqlite_foreign_keys(dbapi_connection, _record):
    # SQLite ignores foreign keys (and so ON DELETE CASCADE) unless asked per connection.
    if type(dbapi_connection).__module__.startswith("sqlite3"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
