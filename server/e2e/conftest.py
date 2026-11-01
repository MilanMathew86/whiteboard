"""End-to-end tests: the real app in Chromium and WebKit against a live test server.

Run with:  pytest server/e2e --browser chromium --browser webkit
Sign-in uses the test-only /test/login route (TESTING config only) instead of Google.
"""

import re
import threading
import uuid

import pytest
from playwright.sync_api import expect
from werkzeug.serving import make_server

from chalkback import create_app
from chalkback.config import load_config
from chalkback.extensions import db

expect.set_options(timeout=10_000)


@pytest.fixture(scope="session")
def live_server(tmp_path_factory):
    cfg = load_config("testing")
    cfg.SQLALCHEMY_DATABASE_URI = f"sqlite:///{tmp_path_factory.mktemp('e2e') / 'e2e.db'}"
    app = create_app(cfg)
    with app.app_context():
        db.create_all()
    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.fixture(scope="session")
def base_url(live_server):
    return live_server


@pytest.fixture
def browser_context_args(browser_context_args):
    return {**browser_context_args, "viewport": {"width": 1280, "height": 800}, "accept_downloads": True}


def unique_email(name="user"):
    return f"{name}-{uuid.uuid4().hex[:8]}@example.com"


def sign_in(context, base_url, email, role=None):
    """Sign this browser context in (shares cookies with its pages)."""
    body = {"email": email, "name": email.split("-")[0].title()}
    if role:
        body["role"] = role
    r = context.request.post(f"{base_url}/test/login", data=body)
    assert r.ok, r.text()
    return r.json()


@pytest.fixture
def errors(page, base_url):
    """Uncaught errors and console errors raised by this site's own code (not Google's)."""
    found = []
    page.on("pageerror", lambda e: found.append(str(e)))

    def on_console(msg):
        if msg.type == "error" and msg.location.get("url", "").startswith(base_url):
            found.append(msg.text)

    page.on("console", on_console)
    return found


@pytest.fixture
def dialogs(page):
    """Answer confirm()/prompt() dialogs: set `dialogs.answer` (True/False or a string)."""

    class Answers:
        answer = True
        seen = []

    def handle(dialog):
        Answers.seen.append(dialog.message)
        if Answers.answer is False:
            dialog.dismiss()
        elif isinstance(Answers.answer, str):
            dialog.accept(Answers.answer)
        else:
            dialog.accept()

    page.on("dialog", handle)
    return Answers


def draw(page, y=420, x0=300, length=240):
    """Draw one stroke on the board."""
    page.mouse.move(x0, y)
    page.mouse.down()
    for i in range(1, 13):
        page.mouse.move(x0 + length * i / 12, y + (20 if i % 2 else -20))
    page.mouse.up()


def stroke_count(page):
    return page.evaluate("window.whiteboard.timeline().at(-1).shapes.length")


def board_status(page):
    return page.locator("#boardStatus")


def wait_saved(page):
    expect(board_status(page)).to_have_text("Saved")


def board_id(page):
    m = re.search(r"/b/([A-Za-z0-9_-]+)", page.url)
    assert m, page.url
    return m.group(1)


def new_account_board(page):
    before = page.url
    page.click("#boardsBtn")
    page.click("#newBoardBtn")
    page.wait_for_url(lambda url: "/b/" in url and url != before)
    wait_saved(page)
    return board_id(page)
