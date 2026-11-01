"""ChalkBack server: serves the whiteboard (web/) and its account, sharing and admin API."""

from pathlib import Path

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory, session
from sqlalchemy import text
from werkzeug.middleware.proxy_fix import ProxyFix

from . import models  # noqa: F401 - register the tables with SQLAlchemy
from .config import load_config
from .extensions import db, limiter, migrate
from .security import csrf_protect, load_user, register_error_handlers, security_headers, start_session

MIGRATIONS_DIR = str(Path(__file__).resolve().parents[1] / "migrations")

BOARD_PATH = r"/b/<board_id>"


def create_app(config=None):
    cfg = config if config is not None and not isinstance(config, str) else load_config(config)
    web_dir = str(cfg.WEB_DIR)
    app = Flask(__name__, static_folder=web_dir, static_url_path="")
    app.config.from_object(cfg)
    if app.config["PROXY_FIX"]:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db.init_app(app)
    migrate.init_app(app, db, directory=MIGRATIONS_DIR, render_as_batch=True)
    limiter.init_app(app)

    from .auth import bp as auth_bp
    from .auth import init_oauth
    init_oauth(app)
    app.register_blueprint(auth_bp)

    from .api import admin, boards, me, shares
    for module in (me, boards, shares, admin):
        app.register_blueprint(module.bp)

    app.before_request(load_user)
    app.before_request(csrf_protect)
    app.after_request(security_headers)
    register_error_handlers(app)

    @app.get("/")
    def index():
        return send_from_directory(web_dir, "index.html")

    @app.get(BOARD_PATH)
    def board_page(board_id):
        # Board links are a folder deep (/b/<id>), so point the page's relative URLs (style.css,
        # app.js…) back at the root. The file itself keeps relative URLs so it also works as
        # plain files.
        html = (Path(web_dir) / "index.html").read_text(encoding="utf-8")
        return Response(html.replace("<head>", '<head>\n  <base href="/">', 1), mimetype="text/html")

    @app.get("/admin")
    def admin_page():
        if g.user is None or not g.user.is_admin:
            abort(404)
        return send_from_directory(web_dir, "admin.html")

    @app.before_request
    def hide_admin_html():
        # The console is only served through /admin, which checks the role.
        if request.path == "/admin.html":
            abort(404)

    @app.get("/healthz")
    def healthz():
        db.session.execute(text("SELECT 1"))
        return jsonify(ok=True)

    if app.config["TESTING"]:
        _register_test_login(app)

    return app


def _register_test_login(app):
    """Sign in without Google, for automated tests only. Never registered outside TESTING."""
    from .services.accounts import sign_in_user, user_json

    @app.post("/test/login")
    def test_login():
        body = request.get_json(silent=True) or {}
        email = body.get("email", "user@example.com")
        user = sign_in_user({"sub": body.get("sub", "sub-" + email), "email": email,
                             "name": body.get("name", email.split("@")[0].title())})
        if user is None:
            return jsonify(error={"code": "disabled", "message": "Account disabled"}), 403
        if body.get("role") in ("user", "admin"):
            user.role = body["role"]
            db.session.commit()
        start_session(user)
        return jsonify(user=user_json(user), csrfToken=session["csrf"])
