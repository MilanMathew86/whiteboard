"""Regenerate the board fixtures by drawing in the real app (Playwright, Chromium).

    python server/tests/fixtures/make_fixtures.py

v2-drawing.json:      pen strokes, a rectangle, text, with undo/redo history
v2-image-style.json:  an image (dropped onto the board) on a black, ruled board
v1.json is hand-written: the app no longer produces v1 saves, but still opens them.
"""

import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

from chalkback import create_app
from chalkback.config import load_config

HERE = Path(__file__).parent

DROP_IMAGE = """async () => {
  const c = document.createElement('canvas');
  c.width = 40; c.height = 30;
  const x = c.getContext('2d');
  x.fillStyle = '#1971c2'; x.fillRect(0, 0, 40, 30);
  x.fillStyle = '#ffffff'; x.fillRect(10, 8, 20, 14);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'square.png', { type: 'image/png' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 640, clientY: 420, bubbles: true }));
}"""


def stroke(page, y, x0=300, length=200):
    page.mouse.move(x0, y)
    page.mouse.down()
    for i in range(1, 9):
        page.mouse.move(x0 + length * i / 8, y + (15 if i % 2 else -15))
    page.mouse.up()


def saved(page):
    page.wait_for_timeout(600)
    return json.loads(page.evaluate("localStorage.getItem('whiteboard.v1')"))


def main():
    app = create_app(load_config("testing"))
    server = make_server("127.0.0.1", 0, app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.goto(url)
        stroke(page, 300)
        stroke(page, 360)
        page.keyboard.press("r")
        page.mouse.move(700, 250)
        page.mouse.down()
        page.mouse.move(900, 400)
        page.mouse.up()
        page.keyboard.press("t")
        page.mouse.click(400, 500)
        page.wait_for_selector(".text-editor:focus")
        page.keyboard.type("E = mc^2")
        page.keyboard.press("Escape")
        page.keyboard.press("p")
        stroke(page, 600)
        page.keyboard.press("Control+z")  # leaves one redo entry
        drawing = saved(page)

        page.evaluate("localStorage.clear()")
        page.reload()
        page.evaluate(DROP_IMAGE)
        page.wait_for_timeout(300)
        page.click("#paperBtn")
        page.click('[data-bg="black"]')
        page.click('[data-grid="lines"]')
        styled = saved(page)
        browser.close()
    server.shutdown()

    (HERE / "v2-drawing.json").write_text(json.dumps(drawing, indent=1), encoding="utf-8")
    (HERE / "v2-image-style.json").write_text(json.dumps(styled, indent=1), encoding="utf-8")
    print("wrote", len(drawing["pool"]), "drawing items and", len(styled["assets"]), "image(s)")


if __name__ == "__main__":
    main()
