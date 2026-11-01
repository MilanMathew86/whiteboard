"""Google sign-in (spec §4): OpenID Connect code flow with full-page redirects.

Google's tokens are used once to read the verified identity, then dropped; Drive access stays in
the browser as before.
"""

from urllib.parse import urlencode, urlsplit

from authlib.integrations.base_client.errors import OAuthError
from authlib.integrations.flask_client import OAuth
from flask import Blueprint, current_app, g, jsonify, redirect, request, session, url_for

from .extensions import limiter
from .security import start_session
from .services.accounts import sign_in_user

GOOGLE_DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration"

bp = Blueprint("auth", __name__, url_prefix="/auth")


def init_oauth(app):
    oauth = OAuth(app)
    oauth.register(
        "google",
        server_metadata_url=GOOGLE_DISCOVERY,
        client_kwargs={"scope": "openid email profile"},
    )
    app.extensions["chalkback_google"] = oauth.google


def google():
    return current_app.extensions["chalkback_google"]


def safe_next(value):
    """A local path to return to after sign-in; anything that could leave the site becomes '/'."""
    if not value or not isinstance(value, str):
        return "/"
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return "/"
    return value


def _with_query(path, **params):
    sep = "&" if "?" in path else "?"
    return path + sep + urlencode(params)


def _signin_limit():
    return current_app.config["RATELIMIT_SIGNIN"]


@bp.get("/login")
@limiter.limit(_signin_limit, key_func=lambda: f"ip:{request.remote_addr}")
def login():
    session["next"] = safe_next(request.args.get("next"))
    return google().authorize_redirect(url_for("auth.callback", _external=True), prompt="select_account")


@bp.get("/callback")
@limiter.limit(_signin_limit, key_func=lambda: f"ip:{request.remote_addr}")
def callback():
    next_path = safe_next(session.pop("next", "/"))
    try:
        token = google().authorize_access_token()  # checks state, then the ID token's signature and nonce
    except OAuthError:
        return redirect(_with_query(next_path, signin="failed"))
    claims = token.get("userinfo") or {}
    if not claims.get("sub") or not claims.get("email"):
        return redirect(_with_query(next_path, signin="failed"))
    if claims.get("email_verified") is not True:
        return redirect(_with_query(next_path, signin="unverified"))
    user = sign_in_user(claims)
    if user is None:
        session.clear()
        return redirect(_with_query(next_path, signin="disabled"))
    start_session(user)
    return redirect(_with_query(next_path, signedin="1"))


@bp.post("/logout")
def logout():
    session.clear()
    g.user = None
    return jsonify(ok=True)
