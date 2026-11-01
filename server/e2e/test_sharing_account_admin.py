"""T5.2–T5.3 sharing and view-only, T6 self-service, T7.2 admin console."""

import json
import re
import zipfile

from playwright.sync_api import expect

from conftest import board_status, draw, new_account_board, sign_in, stroke_count, unique_email, wait_saved


def share_board(page, email, permission="view"):
    page.click("#boardsBtn")
    page.locator(".board-row.current").get_by_role("button", name="Share").click()
    page.fill("#shareEmail", email)
    page.select_option("#sharePermission", permission)
    page.click("#shareForm button[type=submit]")
    expect(page.locator("#shareList li", has_text=email)).to_be_visible()


def test_owner_shares_board(page, context, browser, base_url, errors):
    owner, guest = unique_email("own"), unique_email("gst")
    sign_in(context, base_url, owner)
    page.goto("/")
    bid = new_account_board(page)
    draw(page)
    wait_saved(page)
    share_board(page, guest, "edit")
    page.click("#shareClose")

    other = browser.new_context()
    sign_in(other, base_url, guest)
    page2 = other.new_page()
    page2.goto(base_url)
    page2.click("#boardsBtn")
    row = page2.locator(".board-row", has_text="Untitled board")
    expect(row).to_contain_text("can edit")
    row.locator(".board-open").click()
    expect(page2).to_have_url(re.compile(bid))
    wait_saved(page2)
    assert stroke_count(page2) == 1
    draw(page2, y=500)  # editors can save
    wait_saved(page2)
    other.close()
    assert errors == []


def test_change_and_remove_share(page, context, base_url):
    sign_in(context, base_url, unique_email("chg"))
    page.goto("/")
    new_account_board(page)
    guest = unique_email("g")
    share_board(page, guest, "view")
    item = page.locator("#shareList li", has_text=guest)
    item.locator("select").select_option("edit")
    expect(page.locator("#toast")).to_contain_text("can now edit")
    item.get_by_role("button", name="Remove").click()
    expect(page.locator("#shareList li")).to_have_count(0)


def test_viewer_mode(page, context, browser, base_url, errors):
    owner, viewer = unique_email("own"), unique_email("vwr")
    sign_in(context, base_url, owner)
    page.goto("/")
    bid = new_account_board(page)
    draw(page)
    wait_saved(page)
    share_board(page, viewer, "view")

    other = browser.new_context(accept_downloads=True)
    sign_in(other, base_url, viewer)
    page2 = other.new_page()
    puts = []
    page2.on("request", lambda r: puts.append(r.url) if r.method == "PUT" else None)
    page2.goto(f"{base_url}/b/{bid}")
    expect(board_status(page2)).to_have_text("View only")
    expect(page2.locator("body")).to_have_class(re.compile("view-only"))
    assert page2.evaluate("document.querySelector('#tools').inert") is True
    draw(page2, y=500)
    assert stroke_count(page2) == 1  # drawing did nothing
    expect(page2.locator("#undo")).to_be_disabled()

    page2.click("#zoomIn")  # zoom still works
    expect(page2.locator("#zoomPct")).to_have_text("120%")
    page2.click("#replayBtn")  # replay still works
    expect(page2.locator("#replayBar")).to_be_visible()
    page2.keyboard.press("Escape")
    with page2.expect_download() as dl:
        page2.keyboard.press("Control+s")  # PDF export still works
    assert dl.value.suggested_filename.endswith(".pdf")
    assert puts == []

    page2.click("#copyBoardBtn")  # make an editable copy
    expect(page2).not_to_have_url(re.compile(bid))
    expect(board_status(page2)).to_have_text("Saved")
    draw(page2, y=550)
    wait_saved(page2)
    assert stroke_count(page2) == 2
    other.close()
    assert errors == []


def test_share_revoked_while_open(page, context, browser, base_url):
    owner, editor = unique_email("own"), unique_email("edt")
    sign_in(context, base_url, owner)
    page.goto("/")
    bid = new_account_board(page)
    share_board(page, editor, "edit")

    other = browser.new_context()
    sign_in(other, base_url, editor)
    page2 = other.new_page()
    page2.goto(f"{base_url}/b/{bid}")
    wait_saved(page2)

    page.locator("#shareList li", has_text=editor).get_by_role("button", name="Remove").click()
    expect(page.locator("#shareList li")).to_have_count(0)

    draw(page2)
    expect(page2.locator("#toast")).to_contain_text("can't edit this board any more")
    expect(board_status(page2)).to_have_text("View only — changes not saved")
    expect(page2.locator("#copyBoardBtn")).to_be_visible()
    other.close()


def test_edit_display_name(page, context, browser, base_url):
    owner, guest = unique_email("dn"), unique_email("dg")
    sign_in(context, base_url, owner)
    page.goto("/")
    page.click("#accountBtn")
    page.click("#accountSettingsBtn")
    page.fill("#displayNameInput", "Professor Plum")
    page.press("#displayNameInput", "Enter")
    expect(page.locator("#toast")).to_have_text("Name saved")
    page.click("#settingsCancel")
    page.click("#accountBtn")
    expect(page.locator("#accountName")).to_have_text("Professor Plum")
    page.keyboard.press("Escape")

    new_account_board(page)
    share_board(page, guest)
    other = browser.new_context()
    sign_in(other, base_url, guest)
    page2 = other.new_page()
    page2.goto(base_url)
    page2.click("#boardsBtn")
    expect(page2.locator(".board-row", has_text="Untitled board")).to_contain_text("Professor Plum")
    other.close()


def test_export_download(page, context, base_url):
    sign_in(context, base_url, unique_email("exp"))
    page.goto("/")
    new_account_board(page)
    draw(page)
    wait_saved(page)
    page.click("#accountBtn")
    page.click("#accountSettingsBtn")
    with page.expect_download() as dl:
        page.click("#exportDataBtn")
    zf = zipfile.ZipFile(dl.value.path())
    boards = [n for n in zf.namelist() if n.startswith("boards/")]
    assert len(boards) == 1 and len(json.loads(zf.read(boards[0]))["shapes"]) == 1


def test_delete_account_flow(page, context, base_url, dialogs):
    email = unique_email("del")
    page.goto("/")
    draw(page)  # a local board, which must survive
    page.wait_for_timeout(500)
    sign_in(context, base_url, email)
    page.goto("/")
    bid = new_account_board(page)
    page.click("#accountBtn")
    page.click("#accountSettingsBtn")
    page.fill("#deleteConfirmInput", email)
    page.click("#deleteAccountBtn")
    expect(page.locator("#toast")).to_have_text("Your account was deleted")
    expect(page.locator("#signInBtn")).to_be_visible()
    expect(page).to_have_url(f"{base_url}/")
    assert stroke_count(page) == 1
    sign_in(context, base_url, email)  # the same Google account later: a fresh, empty account
    assert page.evaluate(f"fetch('/api/boards/{bid}').then(r => r.status)") == 404


def test_admin_console(page, context, browser, base_url, dialogs):
    target = unique_email("tgt")
    victim = browser.new_context()
    sign_in(victim, base_url, target)
    sign_in(context, base_url, unique_email("adm"), role="admin")

    page.goto("/")
    page.click("#accountBtn")
    page.click("#adminLink")
    expect(page).to_have_url(f"{base_url}/admin")
    page.fill("#searchInput", target)
    page.press("#searchInput", "Enter")
    row = page.locator("#usersBody tr", has_text=target)
    expect(row).to_have_count(1)

    row.get_by_role("button", name="Disable").click()
    expect(row.locator(".admin-badge")).to_have_text("Disabled")
    assert victim.request.get(f"{base_url}/api/me").json() == {"user": None}  # signed out at once
    row.get_by_role("button", name="Enable").click()
    expect(row.locator(".admin-badge")).to_have_text("Active")
    row.get_by_role("button", name="Make admin").click()
    expect(row).to_contain_text("Admin")
    row.get_by_role("button", name="Delete").click()
    expect(page.locator("#usersBody tr", has_text=target)).to_have_count(0)
    assert len(dialogs.seen) == 4  # every action asked first

    page.click('[data-tab="audit"]')
    for label in ("Changed status", "Changed role", "Deleted user"):
        expect(page.locator("#auditBody")).to_contain_text(label)
    victim.close()


def test_admin_page_redirects_non_admins(page, context, base_url):
    sign_in(context, base_url, unique_email("usr"))
    assert page.goto("/admin").status == 404
