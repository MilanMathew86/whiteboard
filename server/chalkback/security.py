"""Sessions, access guards, CSRF and response headers (spec §4, §11)."""

import hmac
import secrets
from functools import wraps

from flask import current_app, g, jsonify, request, session
from werkzeug.exceptions import HTTPException

from .extensions import db
from .models import User

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# The policy the app shipped with in its <meta> tag, now sent as a header, plus
# frame-ancestors (only possible in a header) and Google profile pictures for the account menu.
#   scripts: this site, the pinned jsPDF folder on cdnjs, Google sign-in and the API loader (Picker)
#   connect: this site's API, Google Drive, Google sign-in, Anthropic
#   frames:  Google sign-in and the Google Picker
#   images:  this site, data: (board images), blob: (decoding uploads), Google profile pictures
#   styles:  inline allowed because Google's sign-in and Picker scripts inject <style> blocks
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.2.1/ https://accounts.google.com/gsi/client "
    "https://apis.google.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self' https://www.googleapis.com https://accounts.google.com/gsi/ https://api.anthropic.com",
    "frame-src https://accounts.google.com/gsi/ https://docs.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
])


class ApiError(Exception):
    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def error_response(status, code, message, **extra):
    return jsonify(error={"code": code, "message": message}, **extra), status


# ---------- Sessions ----------

def start_session(user):
    """Sign the user in on this browser: a fresh session with a new CSRF token."""
    session.clear()
    session.permanent = True
    session["uid"] = user.id
    session["epoch"] = user.session_epoch
    session["csrf"] = secrets.token_urlsafe(32)


def load_user():
    """Before each request: the signed-in user, if the session is still valid."""
    g.user = None
    uid = session.get("uid")
    if uid is None:
        return
    user = db.session.get(User, uid)
    if user is None or not user.is_active or session.get("epoch") != user.session_epoch:
        session.clear()  # deleted, disabled, or signed out everywhere
        return
    g.user = user


def bump_epoch(user):
    """Sign the user out on every device."""
    user.session_epoch += 1


def csrf_protect():
    """Before each request: state-changing requests must come from this site, with the session's token."""
    if request.method in SAFE_METHODS:
        return None
    if not (request.path.startswith("/api/") or request.path.startswith("/auth/")):
        return None
    origin = request.headers.get("Origin")
    if origin is not None and origin != request.host_url.rstrip("/"):
        return error_response(403, "bad_origin", "Request came from another site")
    if g.user is None:
        return None  # nothing to protect; the endpoint itself answers 401 where sign-in is needed
    sent = request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf", "")
    if not expected or not hmac.compare_digest(sent, expected):
        return error_response(403, "bad_csrf", "Your session token is missing or out of date — reload the page")
    return None


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if g.user is None:
            raise ApiError(401, "signed_out", "Please sign in")
        return view(*args, **kwargs)
    return wrapper


def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if g.user is None:
            raise ApiError(401, "signed_out", "Please sign in")
        if not g.user.is_admin:
            raise ApiError(403, "forbidden", "Admins only")
        return view(*args, **kwargs)
    return wrapper


# ---------- Headers and errors ----------

def security_headers(response):
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    if current_app.config["HSTS"]:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def register_error_handlers(app):
    @app.errorhandler(ApiError)
    def api_error(err):
        return error_response(err.status, err.code, err.message, **err.extra)

    @app.errorhandler(HTTPException)
    def http_error(err):
        # JSON for the API; the default HTML page elsewhere.
        if not request.path.startswith("/api/"):
            return err
        codes = {404: "not_found", 405: "method_not_allowed", 413: "too_large", 429: "rate_limited"}
        messages = {
            413: "That's too large to save",
            429: "Too many requests — wait a moment and try again",
        }
        return error_response(err.code, codes.get(err.code, "http_error"), messages.get(err.code, err.description))
