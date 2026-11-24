"""Small pure grades the product run uses (#5518), unit-tested in the normal lane."""

from __future__ import annotations

import re
from typing import Callable

from ..colors import Rgba, parse_color

#: Words that keep their capitals mid-label (proper nouns, acronyms, letters).
#: Words that keep their capitals mid-label; "termiHub" is a proper noun with a
#: lower-case first letter ("Open in termiHub", #5845).
CAPITAL_WORDS = frozenset(
    {"X", "SSH", "OS", "RDP", "VNC", "SFTP", "WSL", "JSON", "PDF", "VS", "Code", "I", "termiHub"}
)


def is_sentence_case(label: str) -> bool:
    """First word capitalised, later words lower case unless a known capital word."""
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", label)
    if not words or not words[0][0].isupper():
        return False
    return all(w in CAPITAL_WORDS or w == w.lower() for w in words[1:])


_MIX_RE = re.compile(r"color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)")


def mix_with_transparent(value: str, resolve: Callable[[str], Rgba] = parse_color) -> Rgba:
    """Resolve ``color-mix(in srgb, <c> N%, transparent)`` to ``<c>`` at N% alpha.

    That is what the CSS mix with ``transparent`` paints (premultiplied srgb).
    ``resolve`` turns the inner colour (e.g. ``var(--accent-color)``) into RGBA;
    any other value is parsed as a plain colour.
    """
    match = _MIX_RE.match(value.strip())
    if not match:
        return parse_color(value)
    base = resolve(match.group(1))
    return Rgba(base.r, base.g, base.b, base.a * float(match.group(2)) / 100)


def painted_terminal_problems(
    measure: dict, viewport_rows: list[str], expected: list[str]
) -> list[str]:
    """What keeps ``expected`` from being *visible* in a terminal; empty when it is.

    A buffer read is not enough (#5620): after an automatic reconnect the tab's
    fresh xterm element stayed parked off screen, so the buffer held every line
    while the pane painted blank. ``measure`` is ``measureTerminal``'s value.
    The element must sit in its panel slot (``slotted``) with a visible area,
    and every ``expected`` text must be on a rendered row: the DOM renderer's
    painted rows, or on WebGL (which paints rows from the viewport) the
    viewport's rows ``viewport_rows``.
    """
    problems: list[str] = []
    if measure.get("slotted") is False:
        problems.append("the terminal element is parked off screen, not in its tab's slot")
    rect = measure.get("visibleRect") or {}
    if (rect.get("width") or 0) <= 0 or (rect.get("height") or 0) <= 0:
        problems.append(f"the terminal has no visible area (visibleRect {rect or None})")
    dom_rows = measure.get("domRows")
    rows = dom_rows if dom_rows is not None else viewport_rows
    source = "painted DOM rows" if dom_rows is not None else "viewport rows"
    text = "\n".join(rows)
    missing = [e for e in expected if e not in text]
    if missing:
        problems.append(f"not on the {source}: {missing}")
    return problems


#: The scrollback line a dropped session writes, per kind of drop (#5619):
#: ``server_closed`` is an SSH / Telnet server that closed the connection
#: cleanly, ``network`` a broken link (#5696).
DROP_SEPARATORS = {
    "network": re.compile(r"— connection lost \d{2}:\d{2}:\d{2} —"),
    "server_closed": re.compile(r"— connection closed by server \d{2}:\d{2}:\d{2} —"),
    "serial": re.compile(r"— device disconnected \d{2}:\d{2}:\d{2} —"),
}
#: The marker written after a reconnect (#5660).
RECONNECTED_MARKER = re.compile(r"— reconnected \d{2}:\d{2}:\d{2} —")


def drop_separator_problems(buffer: str, kind: str, *, reconnected: bool = True) -> list[str]:
    """What is wrong with how a dropped session is marked in the scrollback.

    A dropped link or unplugged device is not a process exit (#5619): the
    buffer must carry the timed ``kind`` separator (``network`` /
    ``server_closed`` / ``serial``), none of the other kinds' separators
    (#5696: a clean server close must not read "connection lost") and no
    ``[Process exited]``; after a reconnect it must also carry the
    ``— reconnected hh:mm:ss —`` marker (#5660). Empty when it is right.
    """
    problems: list[str] = []
    if "[Process exited" in buffer:
        problems.append("the drop reads as '[Process exited]'")
    if not DROP_SEPARATORS[kind].search(buffer):
        problems.append(f"no {kind} drop separator in the scrollback")
    for other, pattern in DROP_SEPARATORS.items():
        if other != kind and pattern.search(buffer):
            problems.append(f"the drop reads as a {other} drop, not {kind}")
    if reconnected and not RECONNECTED_MARKER.search(buffer):
        problems.append("no '— reconnected hh:mm:ss —' marker after the reconnect")
    return problems


def reconnect_wording_problems(text: str, *, serial: bool = False) -> list[str]:
    """What is wrong with the reconnect notice's wording for its transport (#5619).

    A serial device has no shell or agent, so a serial notice must mention
    neither. Any notice that mentions an agent must name the termiHub remote
    agent — a bare "agent" reads as ssh-agent in an SSH tab. Empty when right.
    """
    problems: list[str] = []
    lower = text.lower()
    if serial:
        for word in ("agent", "shell"):
            if word in lower:
                problems.append(f"the serial notice mentions {word!r}: {text!r}")
    elif "agent" in lower and "termihub remote agent" not in lower:
        problems.append(f"the notice says 'agent' without 'termiHub remote agent': {text!r}")
    return problems


#: A raw ``\\NNN`` octal escape: an ``echo`` that did not expand it (#5822).
OCTAL_ESCAPE = re.compile(r"\\[0-7]{3}")
#: The setup script's one summary line after a successful install (#5822).
SETUP_INSTALLED_LINE = re.compile(
    # A dev build names its branch, flat: "Agent v0.1.0 (develop) installed at
    # ~/.local/bin/termihub-agent." (#5956), never "(v0.1.0 (branch: develop))".
    r"^Agent v[^()\s]+(?: \([^()\s]+\))? installed at \S.*\. You can close this tab\.$"
)
#: What the summary-line problem calls the line it wanted.
SETUP_INSTALLED_WANT = "no 'Agent v<x> installed at <path>.' summary line"
#: Shell cleanup commands that must not be the visible setup output (#5822).
_SETUP_NOISE = re.compile(r"(^|[;&|]\s*)(rm -f|rmdir)\s")


def setup_output_problems(buffer: str, *, expect_success: bool = True) -> list[str]:
    """What is wrong with the agent setup terminal's output (#5822).

    The output must carry no raw octal escapes (``\\360\\237…``, R-002), no
    ``rm -f``/``rmdir`` cleanup commands as content (R-057), and end in one
    plain summary line: ``Agent v<x> installed at <path>. You can close
    this tab.`` on success, ``Agent setup failed: <reason>`` on failure.
    Empty when it is right.
    """
    problems: list[str] = []
    escape = OCTAL_ESCAPE.search(buffer)
    if escape:
        problems.append(f"raw octal escape {escape.group(0)!r} in the setup output")
    lines = [line.strip() for line in buffer.replace("\r", "").split("\n")]
    noise = [line for line in lines if _SETUP_NOISE.search(line)]
    if noise:
        problems.append(f"shell cleanup commands in the setup output: {noise[0]!r}")
    installed = [line for line in lines if SETUP_INSTALLED_LINE.match(line)]
    failed = [line for line in lines if line.startswith("Agent setup failed: ")]
    if expect_success:
        if not installed:
            problems.append(SETUP_INSTALLED_WANT)
        if failed:
            problems.append(f"the setup reports a failure: {failed[0]!r}")
    elif not failed:
        problems.append("no 'Agent setup failed: <reason>' summary line")
    return problems

#: ``--form-max-width`` in ``src/styles/variables.css`` (#5641).
FORM_MAX_WIDTH = 560.0
#: ``--form-input-narrow-width``: ports and other short numbers (#5641).
NARROW_INPUT_WIDTH = 160.0
#: Sub-pixel rounding allowance for measured boxes.
_SLACK = 1.0


def _bottom(rect: dict) -> float:
    return float(rect["y"]) + float(rect["height"])


def editor_layout_problems(rects: dict[str, dict]) -> list[str]:
    """What is wrong with the connection editor's layout; empty when it is right (#5641).

    ``rects`` maps a role to a viewport box (``{x, y, width, height}``):
    ``form`` (the settings form), ``header`` (the Connection section header),
    ``env_hint`` (the ``${VAR}`` note), ``host_field`` / ``host_input`` (the
    Host field and its input), ``next_field`` (the field after Host) and, when
    shown, ``host_hint`` (Host's hint) and ``port_input``. The form must stop at the
    width cap; the ``${VAR}`` note must sit inside the section header, above
    the Host field, not between them; Host's hint must sit under Host's input
    and above the next field; the port input must stay narrow.
    """
    problems: list[str] = []
    form = rects["form"]
    if float(form["width"]) > FORM_MAX_WIDTH + _SLACK:
        problems.append(f"the form is {form['width']:.0f}px wide, over the {FORM_MAX_WIDTH:.0f}px cap")
    header, env_hint, host = rects["header"], rects["env_hint"], rects["host_field"]
    if not (float(header["y"]) - _SLACK <= float(env_hint["y"]) and _bottom(env_hint) <= _bottom(header) + _SLACK):
        problems.append("the ${VAR} note is not inside the section header")
    if _bottom(header) > float(host["y"]) + _SLACK:
        problems.append("the section header overlaps the Host field (the note reads as Host's label)")
    host_hint = rects.get("host_hint")
    if host_hint is not None:
        if float(host_hint["y"]) + _SLACK < _bottom(rects["host_input"]):
            problems.append("Host's hint is not below Host's input")
        if _bottom(host_hint) > float(rects["next_field"]["y"]) + _SLACK:
            problems.append("Host's hint runs into the next field")
    port = rects.get("port_input")
    if port is not None and float(port["width"]) > NARROW_INPUT_WIDTH + _SLACK:
        problems.append(f"the port input is {port['width']:.0f}px wide, not narrow")
    return problems


#: The connection editor's two save actions (#5755).
EDITOR_SAVE = "connection-editor-save"
EDITOR_SAVE_CONNECT = "connection-editor-save-connect"


def editor_primary_problems(buttons: "list[dict]", *, editing: bool) -> list[str]:
    """What is wrong with the editor footer's primary action; empty when right (#5755).

    ``buttons`` are the footer's buttons in DOM order, each ``{testId, rect,
    primary}`` (``primary``: it carries the primary skin). A new connection's
    primary is Save and connect; an edited one's is Save. The footer has exactly
    one primary, and it is the right-most button (copy style guide).
    """
    expected = EDITOR_SAVE if editing else EDITOR_SAVE_CONNECT
    return _footer_primary_problems(buttons, expected, "editing" if editing else "a new connection")


#: Words a hint may add to its label and still only restate it (#5835): the
#: protocol, the generic nouns behind the label and filler. "SSH port number"
#: under Port, "Hostname or IP address of the SSH server" under Host.
_RESTATING_WORDS = frozenset(
    "a an the of to or for and use used your this ssh telnet ftp vnc rdp wsl tcp server "
    "hostname host ip address number login name method program path file connect "
    "connection authentication auth shell executable full private key speed".split()
)
_WORD_RE = re.compile(r"[a-z0-9]+")


def hint_restates_label(label: str, hint: str) -> bool:
    """Whether ``hint`` only says ``label`` again (#5835).

    True when every word of the hint is a word of the label or one of the
    restating words (protocol names, the generic nouns behind a label, filler).
    A hint that adds a format, an example or a consequence has another word.
    """
    label_words = set(_WORD_RE.findall(label.lower()))
    hint_words = _WORD_RE.findall(hint.lower())
    return bool(hint_words) and all(w in label_words or w in _RESTATING_WORDS for w in hint_words)


def _overlaps_vertically(a: dict, b: dict) -> bool:
    return float(a["y"]) < _bottom(b) - _SLACK and float(b["y"]) < _bottom(a) - _SLACK


def connection_editor_layout_problems(m: dict) -> list[str]:
    """What is wrong with the connection editor's layout; empty when right (#5835).

    ``m`` holds what the run measured, every key optional:

    - ``type`` / ``name``: the Type select and Name input boxes. Type comes first.
    - ``hints``: ``[{key, label, hint}]`` of the shown fields. No hint only
      repeats its label (:func:`hint_restates_label`).
    - ``host_label`` / ``ssh_import``: the Host label and the "Fill from
      ~/.ssh/config" link boxes. The link sits on Host's label row.
    - ``footer``: the footer buttons, each ``{testId, rect}``. Test is left of
      Cancel and every button sits on one row.
    - ``fields``: ``{key: rect}`` of a remote-desktop editor's shown fields.
      Save password only shows with a password field; the password follows the
      username directly; the SSH tunnel toggle sits after Port, before Username.
    - ``terminal_page`` with ``terminal``: whether the editor offers a Terminal
      page, and whether the type has a terminal. A terminal-less type has none.
    """
    problems: list[str] = []
    if "type" in m and "name" in m and float(m["type"]["y"]) >= float(m["name"]["y"]) - _SLACK:
        problems.append("Type is not above Name")
    for hint in m.get("hints", []):
        if hint_restates_label(hint["label"], hint["hint"]):
            problems.append(f"{hint['key']}: the hint {hint['hint']!r} only repeats {hint['label']!r}")
    if "ssh_import" in m and "host_label" in m and not _overlaps_vertically(m["ssh_import"], m["host_label"]):
        problems.append("'Fill from ~/.ssh/config' is not on the Host label row")
    problems += _footer_layout_problems(m.get("footer", []))
    problems += _remote_desktop_order_problems(m.get("fields", {}))
    if m.get("terminal_page") and m.get("terminal") is False:
        problems.append("a type without a terminal offers a Terminal page")
    return problems


def _footer_layout_problems(buttons: "list[dict]") -> list[str]:
    """Test left of Cancel, every footer button on one row (#5835)."""
    if not buttons:
        return []
    problems: list[str] = []
    by_id = {b["testId"]: b["rect"] for b in buttons}
    test, cancel = by_id.get("connection-editor-test"), by_id.get("connection-editor-cancel")
    if test is not None and cancel is not None and float(test["x"]) >= float(cancel["x"]):
        problems.append("Test is not left of Cancel")
    tops = [float(b["rect"]["y"]) for b in buttons]
    if max(tops) - min(tops) > _SLACK:
        problems.append("the footer buttons are not on one row")
    return problems


def _remote_desktop_order_problems(fields: dict) -> list[str]:
    """Password beside Username; Save password only with a password; tunnel after Port."""
    if not fields:
        return []
    problems: list[str] = []
    y = {key: float(rect["y"]) for key, rect in fields.items()}
    if "savePassword" in y and "password" not in y:
        problems.append("Save password shows without a password field")
    if "username" in y and "password" in y:
        between = [k for k, v in y.items() if y["username"] < v < y["password"]]
        if y["password"] <= y["username"] or between:
            problems.append(f"Password does not follow Username directly (between: {between})")
    if "useSshTunnel" in y:
        if "port" in y and y["useSshTunnel"] <= y["port"]:
            problems.append("the SSH tunnel toggle is above Port")
        if "username" in y and y["useSshTunnel"] >= y["username"]:
            problems.append("the SSH tunnel toggle is below Username, far from Host / Port")
    return problems


#: The tunnel editor's two save actions (#5810).
TUNNEL_EDITOR_SAVE = "tunnel-editor-save"
TUNNEL_EDITOR_SAVE_START = "tunnel-editor-save-start"


def tunnel_editor_primary_problems(buttons: "list[dict]", *, editing: bool) -> list[str]:
    """What is wrong with the tunnel editor footer's primary action; empty when right (#5810).

    Same shape as :func:`editor_primary_problems`: a new tunnel's primary is
    Save and start; an edited one's is Save. Exactly one primary, right-most.
    """
    expected = TUNNEL_EDITOR_SAVE if editing else TUNNEL_EDITOR_SAVE_START
    return _footer_primary_problems(buttons, expected, "editing" if editing else "a new tunnel")


def _footer_primary_problems(buttons: "list[dict]", expected: str, mode: str) -> list[str]:
    """One primary in an editor footer, ``expected``, and it is the right-most button."""
    primaries = [b["testId"] for b in buttons if b.get("primary")]
    problems: list[str] = []
    if primaries != [expected]:
        problems.append(f"{mode}: primary is {primaries or 'none'}, expected [{expected!r}]")
    if buttons:
        rightmost = max(buttons, key=lambda b: float(b["rect"]["x"]) + float(b["rect"]["width"]))
        if rightmost["testId"] != expected:
            problems.append(f"{mode}: the right-most button is {rightmost['testId']!r}, not {expected!r}")
    return problems


def row_leftover_text(text: str, allowed: "list[str]") -> str:
    """What a list row shows beyond its allowed pieces (#5757), whitespace-collapsed.

    A list row may show the item's name, its user-written description and
    compact state markers ("Armed", "Disabled", ...). Each allowed piece is
    removed once, in order; anything left over is settings text that belongs
    in the row's tooltip. ``""`` means the row passes.
    """
    rest = " ".join(text.split())
    for piece in allowed:
        piece = " ".join(piece.split())
        if piece and piece in rest:
            rest = rest.replace(piece, " ", 1)
    return " ".join(rest.split())



# ── Remote desktop tab (#5836) ──────────────────────────────────────────────
#: The first-frame overlay's headline: connect and sign-in are done (#5836).
REMOTE_DESKTOP_WAITING_HEADING = "Waiting for the desktop…"
#: The first-frame overlay's Abort action (#5836).
REMOTE_DESKTOP_WAITING_ABORT = "remote-desktop-first-frame-abort"
#: The toolbar actions every non-view-only remote desktop tab offers.
REMOTE_DESKTOP_TOOLBAR_ACTIONS = (
    "remote-desktop-cad",
    "remote-desktop-clipboard-btn",
    "remote-desktop-scale",
    "remote-desktop-fullscreen",
    "remote-desktop-disconnect",
)
#: The scale modes' visible names (``SCALE_MODE_LABELS`` in ``remoteDesktop.ts``).
REMOTE_DESKTOP_SCALE_LABELS = {"fit": "Fit to tab", "pixel": "1:1 pixel", "match": "Match window"}


def remote_desktop_waiting_problems(text: str, button_ids: "list[str]") -> list[str]:
    """What is wrong with the waiting-for-the-first-frame overlay; empty when right (#5836).

    ``text`` is the overlay's whole text, ``button_ids`` the test ids of its
    buttons. The session is connected and signed in, so the headline names the
    pending step ("Waiting for the desktop…"), never "Connecting to …", and the
    overlay offers Abort.
    """
    problems: list[str] = []
    if REMOTE_DESKTOP_WAITING_HEADING not in text:
        problems.append(f"the headline is not {REMOTE_DESKTOP_WAITING_HEADING!r}: {text!r}")
    if "Connecting to" in text:
        problems.append("the overlay still says 'Connecting to …' after connect and sign-in")
    if REMOTE_DESKTOP_WAITING_ABORT not in button_ids:
        problems.append(f"no Abort on the waiting overlay (buttons: {button_ids})")
    return problems


def remote_desktop_toolbar_problems(toolbar: dict, *, captured: bool) -> list[str]:
    """What is wrong with a live remote desktop tab's toolbar; empty when right (#5836).

    ``toolbar`` is ``{"buttons": [test ids], "scaleMode": "fit"|…, "scaleText": str,
    "keyboardState": "captured"|"released"|None, "keyboardText": str}`` and,
    optionally, ``"opacity"`` (the computed opacity while it should be shown).
    The toolbar carries the common actions, names the active scale mode as
    text, and says where the keyboard goes: to the remote desktop (with the
    release chord) while the canvas holds it, else to termiHub.
    """
    problems: list[str] = []
    buttons = list(toolbar.get("buttons") or [])
    missing = [a for a in REMOTE_DESKTOP_TOOLBAR_ACTIONS if a not in buttons]
    if missing:
        problems.append(f"the toolbar lacks {missing}")
    mode = toolbar.get("scaleMode")
    label = REMOTE_DESKTOP_SCALE_LABELS.get(str(mode))
    scale_text = " ".join(str(toolbar.get("scaleText") or "").split())
    if label is None:
        problems.append(f"unknown scale mode {mode!r}")
    elif scale_text != label:
        problems.append(f"the scale button shows {scale_text!r}, not the mode's name {label!r}")
    expected = "captured" if captured else "released"
    state = toolbar.get("keyboardState")
    text = str(toolbar.get("keyboardText") or "")
    if state != expected:
        problems.append(f"the keyboard state reads {state!r}, expected {expected!r}")
    elif captured and "remote" not in text:
        problems.append(f"a captured keyboard does not say it goes to the remote: {text!r}")
    elif not captured and "termiHub" not in text:
        problems.append(f"a released keyboard does not say it goes to termiHub: {text!r}")
    opacity = toolbar.get("opacity")
    if opacity is not None and float(opacity) < 0.99:
        problems.append(f"the toolbar is not shown (opacity {opacity})")
    return problems
