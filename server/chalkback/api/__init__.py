from flask import current_app, request

from ..extensions import limiter

# State-changing endpoints share one budget per user (or per IP when signed out), and admin
# actions another (spec §11).
writes_limited = limiter.shared_limit(lambda: current_app.config["RATELIMIT_WRITES"], scope="writes")
admin_limited = limiter.shared_limit(lambda: current_app.config["RATELIMIT_ADMIN"], scope="admin")


def json_body():
    """The request's JSON object, or {} — the endpoints validate the fields they need."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}
