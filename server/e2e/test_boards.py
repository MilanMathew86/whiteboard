"""T3.4 account menu, T4.3–T4.6 account boards, autosave, list, conflicts and import."""

import re

from playwright.sync_api import expect

from conftest import (
    board_id,
    board_status,
    draw,
    new_account_board,
    sign_in,
    stroke_count,
    unique_email,
    wait_saved,
)


def test_sign_in_and_out(page, context, base_url, errors):
    email = unique_email("ann")
    sign_in(context, base_url, email)
    page.goto("/")
    expect(page.locator("#accountBtn")).to_be_visible()
    expect(page.locator("#signInBtn")).to_be_hidden()
    page.click("#accountBtn")
    expect(page.locator("#accountEmail")).to_have_text(email)
    page.click("#signOutBtn")
    expect(page.locator("#signInBtn")).to_be_visible()
    expect(page.locator("#accountBtn")).to_be_hidden()
    assert page.evaluate("fetch('/api/me').then(r => r.json())") == {"user": None}
    assert errors == []


def test_autosave_to_account(page, context, browser, base_url, errors):
    email = unique_email("sam")
    sign_in(context, base_url, email)
    page.goto("/")
    bid = new_account_board(page)
    draw(page)
    expect(board_status(page)).to_have_text("Saving…")
    wait_saved(page)

    other = browser.new_context()
    sign_in(other, base_url, email)
    second = other.new_page()
    second.goto(f"{base_url}/b/{bid}")
    wait_saved(second)
    assert stroke_count(second) == 1
    other.close()
    assert errors == []


def test_saves_are_debounced(page, context, base_url):
    sign_in(context, base_url, unique_email("deb"))
    page.goto("/")
    new_account_board(page)
    puts = []
    page.on("request", lambda r: puts.append(r) if r.method == "PUT" else None)
    for i in range(20):
        draw(page, y=200 + i * 25, length=60)
    wait_saved(page)
    assert 1 <= len(puts) <= 4
    assert stroke_count(page) == 20


def test_offline_then_recover(page, context, base_url, errors):
    sign_in(context, base_url, unique_email("off"))
    page.goto("/")
    bid = new_account_board(page)
    context.set_offline(True)
    draw(page)
    expect(board_status(page)).to_have_text(re.compile("Offline|Not saved"))
    context.set_offline(False)
    page.evaluate("window.dispatchEvent(new Event('online'))")
    wait_saved(page)
    page.goto(f"/b/{bid}")
    wait_saved(page)
    assert stroke_count(page) == 1
    # The failed saves themselves are logged by the browser; nothing else may go wrong.
    assert [e for e in errors if "Failed to load resource" not in e] == []


def test_board_style_and_history_persist(page, context, base_url):
    sign_in(context, base_url, unique_email("sty"))
    page.goto("/")
    bid = new_account_board(page)
    draw(page, y=300)
    draw(page, y=450)
    page.click("#paperBtn")
    page.click('[data-bg="black"]')
    page.click('[data-grid="lines"]')
    page.keyboard.press("Escape")
    wait_saved(page)
    page.goto(f"/b/{bid}")
    wait_saved(page)
    assert stroke_count(page) == 2
    assert page.evaluate("window.whiteboard.timeline().length") == 3  # empty, one stroke, two
    expect(page.locator('#paperBg [data-bg="black"]')).to_have_class("active")
    page.keyboard.press("Control+z")
    assert stroke_count(page) == 1


def test_new_open_rename_delete_board(page, context, base_url, dialogs, errors):
    sign_in(context, base_url, unique_email("ren"))
    page.goto("/")
    bid = new_account_board(page)
    expect(page.locator("#boardTitle")).to_have_text("Untitled board")

    dialogs.answer = "Physics notes"
    page.click("#boardsBtn")
    page.locator(".board-row", has_text="Untitled board").get_by_role("button", name="Rename").click()
    expect(page.locator("#boardTitle")).to_have_text("Physics notes")
    expect(page.locator(".board-row.current .board-title")).to_have_text("Physics notes")

    dialogs.answer = True
    page.locator(".board-row", has_text="Physics notes").get_by_role("button", name="Delete").click()
    expect(page).to_have_url(f"{base_url}/")
    expect(page.locator("#boardLabel")).to_be_hidden()
    assert errors == []
    assert context.request.get(f"{base_url}/api/boards/{bid}").status == 404


def test_open_board_by_url_and_back_button(page, context, base_url):
    sign_in(context, base_url, unique_email("nav"))
    page.goto("/")
    first = new_account_board(page)
    draw(page)
    wait_saved(page)
    second = new_account_board(page)
    assert first != second and stroke_count(page) == 0
    page.go_back()
    expect(page).to_have_url(re.compile(first))
    wait_saved(page)
    assert stroke_count(page) == 1
    page.goto(f"/b/{second}")
    wait_saved(page)
    assert board_id(page) == second


def test_no_access_message(page, context, base_url):
    sign_in(context, base_url, unique_email("nop"))
    page.goto("/b/doesnotexist12345")
    expect(page.locator("#toast")).to_have_text("That board doesn't exist or isn't shared with you")
    expect(page).to_have_url(f"{base_url}/")
    draw(page)  # back on the local board, which works
    assert stroke_count(page) == 1


def test_conflict_dialog(page, context, browser, base_url, dialogs):
    email = unique_email("con")
    sign_in(context, base_url, email)
    page.goto("/")
    bid = new_account_board(page)

    other = browser.new_context()
    sign_in(other, base_url, email)
    page2 = other.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.goto(f"{base_url}/b/{bid}")
    wait_saved(page2)

    draw(page, y=300)
    wait_saved(page)          # first device saves version 2
    draw(page2, y=500)        # second device still has version 1
    expect(page2.locator("#conflictModal")).to_be_visible()
    expect(board_status(page2)).to_have_text("Not saved — someone else changed it")

    # Keep mine as a copy: a new board with the second device's content.
    page2.click("#conflictCopy")
    expect(page2.locator("#conflictModal")).to_be_hidden()
    expect(page2.locator("#boardTitle")).to_have_text("Untitled board (my copy)")
    assert board_id(page2) != bid
    assert stroke_count(page2) == 1

    # Load their version: the second device opens the original again and gets the first's stroke.
    page2.goto(f"{base_url}/b/{bid}")
    wait_saved(page2)
    draw(page, y=350)
    wait_saved(page)
    draw(page2, y=550)
    expect(page2.locator("#conflictModal")).to_be_visible()
    page2.click("#conflictTheirs")
    wait_saved(page2)
    assert stroke_count(page2) == 2

    # Overwrite: the second device's board replaces the server's.
    draw(page, y=380)
    wait_saved(page)
    draw(page2, y=600)
    draw(page2, y=620)
    expect(page2.locator("#conflictModal")).to_be_visible()
    page2.click("#conflictOverwrite")
    wait_saved(page2)
    page.goto(f"/b/{bid}")
    wait_saved(page)
    assert stroke_count(page) == 4  # 2 it had + 2 from the second device; not the first's third
    other.close()


def test_save_local_board_to_account(page, context, base_url):
    page.goto("/")
    draw(page)
    page.wait_for_timeout(500)
    sign_in(context, base_url, unique_email("imp"))
    page.goto("/?signedin=1")
    expect(page.locator("#importModal")).to_be_visible()
    page.click("#importOk")
    expect(page).to_have_url(re.compile(r"/b/"))
    wait_saved(page)
    bid = board_id(page)
    data = page.evaluate(f"fetch('/api/boards/{bid}').then(r => r.json())")
    assert len(eval_shapes(data)) == 1


def test_decline_import_uploads_nothing(page, context, base_url):
    page.goto("/")
    draw(page)
    page.wait_for_timeout(500)
    sign_in(context, base_url, unique_email("dec"))
    posts = []
    page.on("request", lambda r: posts.append(r.url) if r.method == "POST" else None)
    page.goto("/?signedin=1")
    page.click("#importCancel")
    page.wait_for_timeout(300)
    assert posts == []
    assert page.evaluate("fetch('/api/boards').then(r => r.json())")["owned"] == []


def eval_shapes(board_response):
    import json
    return json.loads(board_response["data"])["shapes"]
