"""Settings for each environment, read from environment variables.

Production refuses to start without its secrets, or with SQLite (most hosts wipe the disk on
every deploy, which would lose every board).
"""

import os
from datetime import timedelta
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parents[2] / "web"

MB = 1024 * 1024


def _env_list(name):
    return {s.strip().lower() for s in os.environ.get(name, "").split(",") if s.strip()}


def _database_url(default):
    url = os.environ.get("DATABASE_URL", default)
    # Some hosts still hand out postgres:// URLs, which SQLAlchemy no longer accepts.
    if url and url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    # Use psycopg 3 for PostgreSQL.
    if url and url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


class Config:
    ENV_NAME = "base"
    TESTING = False
    SECRET_KEY = None
    SQLALCHEMY_DATABASE_URI = None
    GOOGLE_CLIENT_ID = None
    GOOGLE_CLIENT_SECRET = None
    ADMIN_EMAILS = set()
    WEB_DIR = WEB_DIR

    SESSION_COOKIE_NAME = "chalkback_session"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = False
    PERMANENT_SESSION_LIFETIME = timedelta(days=30)
    HSTS = False
    PROXY_FIX = False  # trust X-Forwarded-* from one proxy (set behind a host's load balancer)

    MAX_CONTENT_LENGTH = 16 * MB
    BOARD_MAX_BYTES = 15 * MB
    USER_STORAGE_BYTES = 250 * MB
    MAX_BOARDS_PER_USER = 200
    MAX_SHARES_PER_BOARD = 50

    RATELIMIT_ENABLED = True
    RATELIMIT_STORAGE_URI = "memory://"
    RATELIMIT_HEADERS_ENABLED = True
    RATELIMIT_SIGNIN = "10 per minute"
    RATELIMIT_WRITES = "120 per minute"
    RATELIMIT_ADMIN = "60 per minute"

    @classmethod
    def from_env(cls):
        cls.SECRET_KEY = os.environ.get("SECRET_KEY", cls.SECRET_KEY)
        cls.SQLALCHEMY_DATABASE_URI = _database_url(cls.SQLALCHEMY_DATABASE_URI)
        cls.GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", cls.GOOGLE_CLIENT_ID)
        cls.GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", cls.GOOGLE_CLIENT_SECRET)
        cls.ADMIN_EMAILS = _env_list("ADMIN_EMAILS") or cls.ADMIN_EMAILS
        cls.RATELIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", cls.RATELIMIT_STORAGE_URI)
        cls.PROXY_FIX = os.environ.get("PROXY_FIX", "1" if cls.PROXY_FIX else "") == "1"
        return cls

    @classmethod
    def check(cls):
        """Raise if the settings can't run safely."""


class DevelopmentConfig(Config):
    ENV_NAME = "development"
    SECRET_KEY = "dev-only-not-secret"  # noqa: S105 - development default, never used in production
    SQLALCHEMY_DATABASE_URI = "sqlite:///" + str(Path(__file__).resolve().parents[2] / "instance" / "dev.db")
    GOOGLE_CLIENT_ID = "65282310191-i4bmb3drctvklctaqh6pvn1i58onq9ug.apps.googleusercontent.com"


class TestingConfig(Config):
    ENV_NAME = "testing"
    TESTING = True
    SECRET_KEY = "testing-not-secret"  # noqa: S105
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"
    GOOGLE_CLIENT_SECRET = "test-secret"  # noqa: S105
    ADMIN_EMAILS = {"admin@example.com"}
    # The limiter stays on (Flask-Limiter can't be switched on after start-up) with limits no test
    # reaches; rate-limit tests lower them.
    RATELIMIT_SIGNIN = RATELIMIT_WRITES = RATELIMIT_ADMIN = "100000 per minute"

    @classmethod
    def from_env(cls):
        # Tests don't read the environment, except an optional PostgreSQL URL for migration tests.
        return cls


class ProductionConfig(Config):
    ENV_NAME = "production"
    SESSION_COOKIE_SECURE = True
    HSTS = True
    PROXY_FIX = True
    # Check connections before use (serverless instances sit idle), and don't use server-side
    # prepared statements, which connection poolers such as Neon's PgBouncer may not keep.
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True, "pool_recycle": 300,
                                 "connect_args": {"prepare_threshold": None}}

    @classmethod
    def from_env(cls):
        super().from_env()
        if os.environ.get("VERCEL"):
            # Vercel functions reject request bodies over 4.5 MB, so boards must stay under that.
            cls.MAX_CONTENT_LENGTH = int(4.4 * MB)
            cls.BOARD_MAX_BYTES = 4 * MB
        return cls

    @classmethod
    def check(cls):
        missing = [k for k in ("SECRET_KEY", "SQLALCHEMY_DATABASE_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
                   if not getattr(cls, k)]
        if missing:
            names = {"SQLALCHEMY_DATABASE_URI": "DATABASE_URL"}
            raise RuntimeError("Missing settings: " + ", ".join(names.get(k, k) for k in missing))
        if cls.SQLALCHEMY_DATABASE_URI.startswith("sqlite"):
            raise RuntimeError("SQLite can't be used in production; set DATABASE_URL to PostgreSQL")
        if len(cls.SECRET_KEY) < 32:
            raise RuntimeError("SECRET_KEY must be at least 32 characters")


CONFIGS = {c.ENV_NAME: c for c in (DevelopmentConfig, TestingConfig, ProductionConfig)}


def load_config(name=None):
    name = name or os.environ.get("CHALKBACK_ENV", "development")
    if name not in CONFIGS:
        raise RuntimeError(f"Unknown CHALKBACK_ENV {name!r}; use one of {', '.join(CONFIGS)}")
    # A fresh subclass each time, so reading the environment never leaks between app instances.
    base = CONFIGS[name]
    cfg = type(base.__name__, (base,), {})
    cfg.from_env()
    cfg.check()
    return cfg
