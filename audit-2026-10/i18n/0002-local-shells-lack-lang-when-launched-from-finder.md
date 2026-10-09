---
id: I18N2-002
title: "Local shells inherit no LANG/LC_CTYPE when the app is launched from Finder/Dock on macOS, so the shell runs in the C locale"
angle: i18n
severity: medium
category: locale-environment
is_workaround: false
subsystem: "core/session/shell + backends/local_shell"
evidence:
  - core/src/session/shell.rs:318
  - core/src/session/shell.rs:319
  - core/src/session/shell.rs:320
  - core/src/backends/local_shell.rs:124
  - core/src/backends/local_shell.rs:128
status: fixed
resolution: "#4336 — local shells get a UTF-8 LANG (or LC_CTYPE over C/POSIX) from the system locale unless one is set"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`build_shell_command` injects only TERM and COLORTERM. The PTY child is built
with portable-pty's `CommandBuilder::new`, which copies the parent's
`std::env::vars_os()` unchanged (portable-pty 0.9 get*base_env has no locale
handling). Nothing in src-tauri or core sets LANG; a search for set_var or LANG
defaulting found none. A macOS app launched by launchd (Finder, Dock, Spotlight,
`open`) has no LANG or LC*\* in its environment. Terminal.app, iTerm2, WezTerm
and Alacritty all set LANG themselves for this reason.

## Why it matters

With no locale, zsh or bash on macOS run in the C/POSIX locale even though xterm
decodes UTF-8 correctly (I18N-016). Typed umlauts, accents and CJK show as
escape sequences such as `<00e4>` or `\M-C\M-$` at the prompt. `ls` prints `?`
for non-ASCII filenames, git quotes non-ASCII paths in octal, and vim and less
mis-handle multibyte text. Any user with non-ASCII filenames or input sees
broken local terminals only when the app is launched normally, and it looks fine
under `scripts/dev.sh` from a terminal, which hides the bug from developers. The
workaround is to set LANG per connection, which most users will not know to do.

## Evidence

- `core/src/session/shell.rs:318`
- `core/src/session/shell.rs:319`
- `core/src/session/shell.rs:320`
- `core/src/backends/local_shell.rs:124`
- `core/src/backends/local_shell.rs:128`

## Recommendation

In `build_shell_command`, or once at app start on macOS, add LANG when neither
LANG nor LC_ALL nor LC_CTYPE is set in the inherited environment or in
config.env. Derive it from the system locale (CFLocale / `defaults read -g
AppleLocale`, normalized to `xx_YY.UTF-8`) and fall back to `en_US.UTF-8` if
that locale is not installed, as WezTerm's set_lang_from_locale does. Never
override a value the user or environment already set. Add a unit test: with an
empty base env, the built command carries a UTF-8 LANG; with a user-set LANG, it
is untouched.

## Verification

Confirmed. build_shell_command (core/src/session/shell.rs:318-320) inserts only
TERM and COLORTERM, and local_shell.rs:124-128 passes those to portable-pty's
CommandBuilder::new on top of the inherited environment. No set_var, fix-path-
env or LANG default exists in core or src-tauri, so locale is never pinned. The
only LANG handling in core is the LC_ALL=C prefix on parsed commands (I18N-005)
and the plugin sandbox PASSED_ENV, which passes through whatever LANG exists.
I18N-013's navigator.language 'C' crash shows the app really runs without a
usable locale in practice. No ADR or audit entry treats this as a deliberate
decision. Medium fits: Finder/Dock-launched local shells on macOS silently fall
back to the C locale.
