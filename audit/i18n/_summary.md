# i18n / l10n readiness — audit summary

**Angle:** internationalization & localization readiness (`I18N`).
**Scope:** `src/**` user-facing strings + locale-sensitive operations, and the
Rust side (`core`, `agent`, `src-tauri`) where it formats user-facing text or
parses locale-sensitive command output. Read-only.

## Headline posture

- **i18n architecture: none.** No i18n framework or message catalog exists —
  no `react-intl`/FormatJS, `i18next`, `lingui` in `package.json`; no
  `src/locales/`, no `.po`/`.json` translations, no `t()`/`<FormattedMessage>`.
  Every user-facing string is a hardcoded English literal. The **retrofit is
  large** (rough magnitude: ~353 `toast(...)` literals, ~426
  `title=/placeholder=/aria-label=` literals, 230+ JSX text nodes, across ~197
  `.tsx` + ~295 `.ts` files) → **I18N-012**.
- **But the bigger story is bucket A: the *lack of i18n awareness causes real
  bugs today*, even though the app only ships in English** — because it parses
  and classifies text produced by a **non-English remote host or OS**, which the
  user (not termiHub) controls.
- The one historical crash class (uplot `Intl.NumberFormat` under `C`/POSIX) is
  **already centrally mitigated** by a boot-time `navigator.language` guard
  (**I18N-013**, a tracked workaround), and terminal UTF-8 I/O is **sound by
  design** (xterm's stateful decoder + byte-faithful base64, **I18N-016**). So
  the frontend crash/encoding surface is in good shape; the live bugs are in
  **error classification** and **command-output parsing**.

## Bucket A — locale-dependent bugs that exist NOW (prioritized)

| ID | Severity | Bug |
|----|----------|-----|
| **I18N-001** | **critical** | Destructive credential discard (`removeCredential`) gated on English `"auth failed"`/`"Authentication failed"` substring. A localized/remote message or a reword either loops on a stale credential or deletes a valid one. Safety-relevant path. |
| **I18N-002** | high | Agent connection-error classifier (`classifyAgentError`) routes *all* remediation ("Agent Not Installed" / "Auth Failed" / "Agent Outdated") purely by English substrings; non-English remote/OS collapses everything to a generic error. |
| **I18N-003** | high | Docker file browser parses `stat %F` file-type via `.contains("directory")`/`"symbolic link"` with **no `LC_ALL=C`** → under a non-English container locale, every entry is misdetected as a regular file (dirs unnavigable). |
| **I18N-004** | high | Docker file browser parses `find -printf %T@` mtime as `f64`; a comma-decimal container locale makes the parse fail → `unwrap_or(0.0)` → **every file shows 1970-01-01**. |
| **I18N-007** | medium | Serial-port "busy/in use" classification matches localized OS error text (`"Access is denied"` etc.) — breaks on non-English Windows; the `ErrorKind` arms above it are correct, only the busy path is fragile. |
| **I18N-008** | medium | Agent self-update "expected disconnect = success" detection uses a broad English substring list — mis-reports real failures as success (and vice-versa under localization). |
| **I18N-009** | medium | Terminal connection-overlay hint routing matches English error patterns (incl. the same localized serial/timeout OS text) + splits on a literal `" — "` separator. |
| **I18N-011** | medium | Keyboard shortcut matching keys off `event.key` (layout-mapped char) and a hardcoded `[a-zA-Z]` bindability gate → non-Latin layouts (Cyrillic/Greek/Arabic) can't bind/trigger letter shortcuts; AZERTY/QWERTZ land on wrong physical keys. |
| **I18N-006** | low | FTP `LIST` parser breaks on localized `ls -l` month names → blank mtime (server-locale, not client-controllable; MLSD unaffected). |
| **I18N-010** | low | Import dialog matches backend's English `"wrong password"` text — coupling that breaks on reword/translation (string is internal, so stable today). |

**Common root cause & fix:** most of bucket A is *classification by human-readable
message*. The durable remedy is to propagate **structured, machine-stable error
kinds / codes** from the Rust backend to the frontend and switch on those, and to
**force `LC_ALL=C LANG=C` on every parsed command** (see I18N-005). Doing the
structured-error work is a hard prerequisite for *ever* localizing the Rust error
strings safely — and is worth doing purely for correctness even if translation is
deferred.

## Bucket A — systemic / latent

| ID | Severity | Finding |
|----|----------|---------|
| **I18N-005** | medium | **No parsed command anywhere forces `LC_ALL=C`.** The monitoring hot path (`/proc` + `df -P`) is safe *only by data source*, not by design — one switch to `free`/`vmstat`/non-`-P df` silently breaks numeric parsing. Fix by centralizing a C-locale prefix in the exec helpers. |

## Bucket B — localization-readiness debt (translation retrofit)

| ID | Severity | Finding |
|----|----------|---------|
| **I18N-012** | high | No framework/catalog; every string hardcoded → full externalization needed. Quantified above. |
| **I18N-013** | info (workaround) | `navigator.language` monkeypatched at boot to defuse the uplot `C`-locale crash; correctness depends on it staying the first import — harden with a lint/test. |
| **I18N-014** | low | All string sorts use default `localeCompare` (no options) → locale-dependent, non-natural (`file10<file2`) ordering; add a shared `Intl.Collator`. |
| **I18N-015** | low | Byte/number/time formatters are hand-rolled English-only `.toFixed` (crash-safe) and `formatBytes` is triplicated; consolidate + route through `Intl.NumberFormat`. |
| **I18N-016** | low (test-gap) | Encoding is sound but IME/CJK/RTL/combining/emoji input has **no automated coverage** across webview platforms. |
| **I18N-017** | low | No RTL support: ~82 physical `*-left/-right` CSS props, 0 logical (`*-inline-*`); adopt logical properties in new CSS to stop the debt growing. |

## Top 5 risks (ranked)

1. **I18N-001 (critical)** — English-substring gate on a **destructive credential
   discard**. Wrong under a non-English/remote message; can delete a valid
   credential or trap the user on a stale one. Safety-critical path.
2. **I18N-004 (high)** — Docker file mtimes silently reset to **1970** under any
   comma-decimal container locale (a very common locale class); parse failure is
   swallowed by `unwrap_or(0.0)`.
3. **I18N-003 (high)** — Docker directories/symlinks misdetected as files under a
   non-English container locale → file browsing broken (can't navigate).
4. **I18N-002 (high)** — All agent-connection remediation guidance keyed off
   English substrings; non-English remote/OS collapses it to a useless generic
   error exactly when the user most needs the tailored hint.
5. **I18N-012 (high)** — Zero i18n infrastructure: localizing the app is a full
   retrofit, and it *cannot be done safely* until the structured-error work
   (risks 1, 3–4 above) removes the frontend's dependence on English message text.

## Overall localization-readiness read

**Not ready — but the priority is inverted from a normal l10n audit.** termiHub
ships English-only and has **no i18n framework** (a large but ordinary retrofit,
I18N-012). The urgent problems are not translation friction — they are **live,
present-day bugs caused by locale-unawareness on the machine side**: the app
classifies transport/OS/agent errors and parses container command output by
English substring, so a **non-English remote host, container, or OS silently
breaks real features today** (credential handling, Docker file browsing,
serial/agent diagnostics) with the UI still in English. These are safety- and
reliability-relevant and should be fixed regardless of any translation plan. The
correct sequencing is: (1) convert error classification to **structured codes**
and force **`LC_ALL=C`** on parsed commands (fixes bucket A), then (2) decide on
translation and adopt a framework (bucket B). The good news: the historical
`Intl` crash is already contained, terminal UTF-8 handling is sound, and sorting
already uses `localeCompare` — so the foundation for step 2 is reasonable once the
structured-error work lands.
