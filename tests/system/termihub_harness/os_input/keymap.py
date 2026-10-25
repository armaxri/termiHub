"""US-ANSI key positions shared by the macOS and Windows backends (#4935).

Both platforms take a *physical* key (macOS virtual keycode, Windows virtual-key
code) and let the target's keyboard layout turn it into a character, which is
exactly what makes dead keys and Option/AltGr combos real. To type plain text
we map each ASCII character to the US key that produces it, plus Shift.
"""

from __future__ import annotations

from typing import Optional

#: Characters typed with Shift on a US layout → the unshifted key.
SHIFTED = {
    "!": "1",
    "@": "2",
    "#": "3",
    "$": "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
    ")": "0",
    "_": "-",
    "+": "=",
    "{": "[",
    "}": "]",
    "|": "\\",
    ":": ";",
    '"': "'",
    "<": ",",
    ">": ".",
    "?": "/",
    "~": "`",
}

#: macOS virtual keycodes (``kVK_*``, Carbon ``Events.h``) by portable name.
MAC_KEYCODES = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
    "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, " ": 49, "`": 50,
    "grave": 50, "backspace": 51, "escape": 53, "cmd": 55, "shift": 56,
    "caps_lock": 57, "alt": 58, "ctrl": 59, "f5": 96, "f6": 97, "f7": 98, "f3": 99,
    "f8": 100, "f9": 101, "f11": 103, "f10": 109, "f12": 111, "home": 115,
    "delete": 117, "f4": 118, "end": 119, "f2": 120, "f1": 122, "left": 123,
    "right": 124, "down": 125, "up": 126,
}  # fmt: skip

#: Windows virtual-key codes for the non-alphanumeric portable names.
WIN_VK = {
    "enter": 0x0D, "escape": 0x1B, "tab": 0x09, "space": 0x20, " ": 0x20,
    "backspace": 0x08, "delete": 0x2E, "home": 0x24, "end": 0x23, "left": 0x25,
    "up": 0x26, "right": 0x27, "down": 0x28, "caps_lock": 0x14, "shift": 0x10,
    "ctrl": 0x11, "alt": 0x12, "altgr": 0xA5, "super": 0x5B, "cmd": 0x5B,
    ";": 0xBA, "=": 0xBB, ",": 0xBC, "-": 0xBD, ".": 0xBE, "/": 0xBF, "`": 0xC0,
    "grave": 0xC0, "[": 0xDB, "\\": 0xDC, "]": 0xDD, "'": 0xDE,
}  # fmt: skip


def us_key_for_char(char: str) -> Optional[tuple[str, bool]]:
    """``(key, shift)`` that types ``char`` on a US layout, or ``None``."""
    if len(char) != 1:
        return None
    if char == "\n":
        return "enter", False
    if char == "\t":
        return "tab", False
    if char.isascii() and char.isalpha():
        return char.lower(), char.isupper()
    if char in SHIFTED:
        return SHIFTED[char], True
    if char in MAC_KEYCODES:
        return char, False
    return None


def mac_keycode(key: str) -> int:
    try:
        return MAC_KEYCODES[key]
    except KeyError:
        raise ValueError(f"no macOS keycode for key {key!r}") from None


def win_vk(key: str) -> int:
    if key in WIN_VK:
        return WIN_VK[key]
    if len(key) == 1 and key.isascii() and key.isalnum():
        return ord(key.upper())
    if key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        return 0x6F + int(key[1:])
    raise ValueError(f"no Windows virtual-key code for key {key!r}")
