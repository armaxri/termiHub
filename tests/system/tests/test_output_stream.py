"""Unit tests for the raw-output flash helpers (#4931). No app needed."""

from __future__ import annotations

import re

from termihub_harness.output_stream import (
    PROMPT_MARK,
    describe,
    find_flashes,
    first_match_offset,
    markers_in,
    prompt_offsets,
    visible_text,
)


def test_visible_text_drops_escapes_and_controls():
    raw = "\x1b[1;32muser@host\x1b[0m:\x1b]7;file:///home/u\x07~$ \r\nok\x1b[K\x07"
    assert visible_text(raw) == "user@host:~$ \nok"


def test_wipe_before_anything_visible_is_not_a_flash():
    # ConPTY and some shells clear an empty screen at start.
    raw = "\x1b[?25l\x1b[2J\x1b[m\x1b[H\r\n  \x1b[?25hPS C:\\> "
    assert find_flashes(raw) == []


def test_text_then_clear_is_a_flash():
    raw = "Welcome to Ubuntu 24.04\r\n\x1b[H\x1b[2Juser@host:~$ "
    flashes = find_flashes(raw)
    assert len(flashes) == 1
    assert flashes[0].sequence == "\x1b[2J"
    assert flashes[0].erased == "Welcome to Ubuntu 24.04"
    assert flashes[0].offset == raw.index("\x1b[2J")


def test_reset_and_alternate_screen_count_as_wipes():
    assert [f.sequence for f in find_flashes("setup\x1bcprompt$ ")] == ["\x1bc"]
    assert [f.sequence for f in find_flashes("x\x1b[?1049hy\x1b[?1049l")] == [
        "\x1b[?1049h",
        "\x1b[?1049l",
    ]
    assert [f.sequence for f in find_flashes("old\x1b[3Jnew")] == ["\x1b[3J"]


def test_line_editor_erases_are_not_wipes():
    raw = "user@host:~$ ls\x1b[K\x1b[J\x1b[0J\x08\x08\x1b[1K"
    assert find_flashes(raw) == []


def test_until_limits_the_search():
    raw = "prompt$ \x1b[2Jlater"
    assert find_flashes(raw, until=raw.index("\x1b[2J")) == []
    assert len(find_flashes(raw)) == 1


def test_prompt_offsets_find_osc_133_a():
    raw = f"motd\r\n{PROMPT_MARK}\x07$ cmd\r\n{PROMPT_MARK}\x1b\\$ "
    assert prompt_offsets(raw) == [6, raw.rindex(PROMPT_MARK)]


def test_first_match_offset_maps_visible_match_to_raw_offset():
    raw = "banner\r\n\x1b[01;32mtestuser@\x1b[0mhost:~$ "
    offset = first_match_offset(raw, re.compile(r"testuser@host"))
    assert offset == raw.index("testuser@")
    assert first_match_offset(raw, "nomatch") is None


def test_markers_in_reports_visible_markers_only():
    raw = "\x1b]7;__termihub_osc7\x07$ echo '# [termiHub] Shell integration'"
    assert markers_in(raw, ["__termihub_osc7", "[termiHub] Shell integration"]) == [
        "[termiHub] Shell integration"
    ]


def test_describe_bounds_the_repr():
    assert describe("a\x1b[2J") == repr("a\x1b[2J")
    long = describe("x" * 50, limit=10)
    assert long.startswith("'xxxxxxxxxx... (+40 chars)") or "+40 chars" in long
