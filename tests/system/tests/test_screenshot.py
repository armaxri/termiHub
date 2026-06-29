"""Screenshot bridge verb against the real app (issue #900).

The in-webview bridge can read state and terminal text but historically could not
*see* the rendered UI, so visual checks (pixel geometry, theme rendering) stayed
manual. The ``screenshot`` verb rasterizes the live DOM to a PNG, which both
enriches the failure-artifact bundle and lets a visual carve-out at least capture
automated evidence. This launches the real app and proves the capture path
returns a valid, non-trivial PNG.

The DOM-rasterization path does not capture the xterm GPU canvas or native OS
dialogs (terminal content is asserted via ``read_terminal`` elsewhere); this test
deliberately asserts only that a real image of the app is produced.
"""

import pytest

from termihub_harness import SystemTest, TerminalUi, screenshot_to_png_bytes

pytestmark = pytest.mark.integration

#: The 8-byte PNG magic every PNG file starts with.
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class TestScreenshot(TerminalUi, SystemTest):
    def test_screenshot_captures_a_png_of_the_app(self):
        # Open a terminal so the captured frame shows real app chrome + content.
        self.ensure_terminal()
        data_url = self.driver.screenshot()

        assert data_url.startswith("data:image/png")
        png = screenshot_to_png_bytes(data_url)
        assert png.startswith(_PNG_SIGNATURE)
        # A capture of the whole window is far larger than a placeholder pixel,
        # proving the DOM actually rasterized rather than returning an empty image.
        assert len(png) > 1000
