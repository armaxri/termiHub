"""The folder an embedded-services test serves, without an app (#6140).

The Windows nightly failed broadly with "The folder /tmp does not exist": the
helpers served a POSIX path by default. A test's served folder is now a fresh
temp dir of the platform, made by the harness.
"""

from __future__ import annotations

import inspect
import tempfile
from pathlib import Path

from termihub_harness.ui.embedded_services import EmbeddedServicesUi, served_folder


def test_served_folder_is_a_fresh_temp_dir_of_this_platform():
    first, second = served_folder(), served_folder()
    assert first != second
    for folder in (first, second):
        assert folder.is_dir() and folder.is_absolute()
        assert folder == folder.resolve()
        assert folder.is_relative_to(Path(tempfile.gettempdir()).resolve())


def test_served_folder_holds_the_file_it_was_asked_for():
    folder = served_folder("hello.txt", "hi")
    assert (folder / "hello.txt").read_text(encoding="utf-8") == "hi"


def test_no_helper_serves_a_posix_path_by_default():
    for helper in (EmbeddedServicesUi.fill_editor, EmbeddedServicesUi.create_server):
        default = inspect.signature(helper).parameters["root"].default
        assert default is None, f"{helper.__name__} serves {default!r} by default"
