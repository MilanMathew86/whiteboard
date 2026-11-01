"""T1.6 drawing smoke test, and T3.4 signed-out behaviour unchanged."""

from playwright.sync_api import expect

from conftest import draw, stroke_count


def test_smoke_signed_out(page, base_url, errors):
    page.goto("/")
    expect(page.locator("#signInBtn")).to_be_visible()
    draw(page)
    assert stroke_count(page) == 1
    page.keyboard.press("Control+z")
    assert stroke_count(page) == 0
    page.keyboard.press("Control+y")
    assert stroke_count(page) == 1

    page.click("#paperBtn")
    page.click('[data-bg="green"]')
    page.click('[data-grid="squares"]')
    page.wait_for_timeout(600)  # autosave
    page.reload()
    assert stroke_count(page) == 1
    expect(page.locator('#paperBg [data-bg="green"]')).to_have_class("active")
    assert page.evaluate("getComputedStyle(document.querySelector('#board')).backgroundColor") == "rgb(43, 74, 58)"
    assert errors == []


def test_signed_out_app_unchanged(page, base_url, errors):
    api_calls = []
    page.on("request", lambda r: api_calls.append(r.url) if "/api/" in r.url else None)
    page.goto("/")
    draw(page)
    page.click("#replayBtn")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    assert [u.replace(base_url, "") for u in api_calls] == ["/api/me"]
    expect(page.locator("#boardsBtn")).to_be_hidden()
    expect(page.locator("#accountBtn")).to_be_hidden()
    assert errors == []


def test_board_link_while_signed_out(page, base_url, errors):
    page.goto("/")
    draw(page)
    page.wait_for_timeout(500)
    page.goto("/b/someboardid123")
    expect(page.locator("#toast")).to_have_text("Sign in to open that board")
    expect(page).to_have_url(f"{base_url}/")
    assert stroke_count(page) == 1  # the local board, untouched

    # Signing in returns to the board link (the redirect to Google is stubbed out).
    requested = []
    page.route("**/auth/login**", lambda route: (requested.append(route.request.url),
                                                 route.fulfill(status=200, body="stub")))
    page.click("#signInBtn")
    page.wait_for_timeout(300)
    assert requested and requested[0].endswith("/auth/login?next=%2Fb%2Fsomeboardid123")
    assert errors == []
