# termiHub Python system-test harness

System/integration tests that drive the **real built app** over the
cross-platform WebSocket test bridge and own the lifecycle of the app and agent
processes. They run identically on Linux, Windows, and macOS — including macOS,
where the WebDriver-based E2E path cannot (no WKWebView driver; see ADR-5).

This is the Python side of the test architecture: a black-box client of the app
over the bridge protocol (issue #801). The bridge command vocabulary is the
contract, kept in parity with the TypeScript dispatcher (`src/testbridge/`). See
[`docs/test-bridge.md`](../../docs/test-bridge.md) for the protocol.

> For the **run / implement / analyze iteration loop** and the tooling
> improvement roadmap, see
> [`docs/system-test-local-workflow.md`](../../docs/system-test-local-workflow.md).

## Layout

| Path                               | Responsibility                                                           |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `termihub_harness/protocol.py`     | Wire envelope encode/decode (mirrors `wsProtocol.ts`)                    |
| `termihub_harness/bridge.py`       | WebSocket bridge server + synchronous `Driver`                           |
| `termihub_harness/orchestrator.py` | `AppInstance` / `AgentInstance` process lifecycle                        |
| `termihub_harness/fixtures.py`     | Docker/Podman container fixtures (SSH, …)                                |
| `termihub_harness/transfers.py`    | FTP (stdlib `ftplib`) / TFTP (`tftpy`) download checkers (SVC-12/13)     |
| `tests/`                           | pytest tests + `fake_app.py` (a WS client stand-in)                      |
| `conftest.py`                      | `bridge` / `app` / `agent` / `ssh_fixtures` / `telnet_fixtures` fixtures |
| `pytest.sh` / `pytest.cmd`         | uv wrapper around `python -m pytest` (bootstraps the venv from uv.lock)  |

## How it works

The runner hosts the WebSocket server; the app connects **out** to it (so no
platform automation driver is needed). The app is launched with
`TERMIHUB_TEST_BRIDGE_PORT=<port>` and an isolated `TERMIHUB_CONFIG_DIR`, then a
`Driver` drives it:

```python
def test_app_lifecycle(bridge, app):
    app.start(bridge.port)
    driver = bridge.wait_for_app()

    driver.click("terminal-view-new-terminal")
    driver.terminal_input("echo HELLO")
    assert "HELLO" in driver.read_terminal()

    app.restart()                       # kill + relaunch
    driver = bridge.wait_for_app()      # re-acquire the bridge (issue #817)
    assert driver.get_state() is not None
```

## Quick start — the `pytest` wrapper

The easiest entry point is the **`pytest.sh`** / **`pytest.cmd`** wrapper in this
directory. It shells out to [uv](https://docs.astral.sh/uv/), which on first use
creates the virtualenv and installs the exact dependency set pinned in
`uv.lock`, then forwards **all arguments verbatim** to `python -m pytest` — so
you never type the `.venv` path and never set up the env by hand:

```sh
# Unix / macOS                         # Windows
./pytest.sh -m "not integration" -v    pytest.cmd -m "not integration" -v
./pytest.sh -m integration -k ssh -v   pytest.cmd -m integration -k ssh -v
./pytest.sh --collect-only -q          pytest.cmd --collect-only -q
```

The wrapper runs from `tests/system/` regardless of where you call it and is a
near no-op once the env is in sync. It requires `uv` on your `PATH` (install:
`curl -LsSf https://astral.sh/uv/install.sh | sh`, or the Windows installer);
pick a specific base interpreter with `UV_PYTHON=3.12` (a version) or a full
path. Every `uv run pytest …` command below can be written as `./pytest.sh …`.

## One command — `scripts/test-system-py.sh`

`pytest.sh` only runs pytest; an **integration** test additionally needs the app
**built** and its Docker **fixtures up**. The repo-level
**[`scripts/test-system-py.sh`](../../scripts/test-system-py.sh)** (+ `.cmd`)
wraps all three steps so you run one command instead of the build → fixtures →
pytest dance:

```sh
# Build a debug app if needed, then run one suite, stop on first fail, stream logs
./scripts/test-system-py.sh --debug -k sftp_infra -x -s

# Bring up only the SSH fixtures, then run the SSH integration tests
./scripts/test-system-py.sh --fixtures "ssh-password ssh-keys" -m integration -k ssh

# Skip the build (reuse the existing binary), run only the fast machinery suite
./scripts/test-system-py.sh --skip-build -m "not integration"

# Just print the resolved plan (profile, build action, fixtures, pytest args)
./scripts/test-system-py.sh --dry-run --debug -k ssh
```

It builds only when the binary is **missing or stale** (a source file is newer),
honoring `--debug` for the fast loop (see [Faster loop](#faster-loop-build-a-debug-app));
pins the harness to the profile it built via `TERMIHUB_TEST_APP_BINARY`; brings
up only the `--fixtures` you name (left running, like the harness's own
fixtures); and forwards every other argument to `pytest.sh`. Use `--` to forward
a token that looks like a runner flag (e.g. `-- --debug`). Fixtures need a
running container runtime (`CONTAINER_CMD=podman` to force Podman).

## Confirming a `data-testid` — the catalog

Stale or dynamic selectors are the #1 authoring error when porting a test. Before
guessing, regenerate and check `testid-catalog.md` — a generated index of
**every** `data-testid` the app renders, scanned from `src/**`. It is a local,
git-ignored artifact (not committed): run the generator to produce it, or let the
autoformat hook refresh it after a `.ts`/`.tsx` edit.

- **Literal** ids match exactly (`connection-editor-save`).
- **Dynamic** ids show a `*` glob for the interpolated part — a row keyed by name
  renders `file-row-*`, a prefixed action renders `*-download`. Build the real id
  from the static part (`file-row-${entry.name}` → `file-row-myfile.txt`).
- **Indirect** ids are passed in by a prop at the call site; the real id is
  defined where the component is used, not at the `data-testid`.

Regenerate it whenever you want a fresh reference (the catalog is not committed,
so a stale one never breaks CI):

```sh
python scripts/build-testid-catalog.py            # rewrite the local catalog
python scripts/build-testid-catalog.py --stdout    # print without writing
```

## Test inventory & coverage gaps

The testid catalog answers _"does this selector exist?"_. It does **not** answer
_"what do we verify for feature X (automated **and** manual), and which features
have **zero** coverage?"_ — the harness is discoverable only by the
`test_<feature>.py` filename convention plus `pytest --collect-only`, with just
the `integration` / `manual` markers. `scripts/build-test-inventory.py` builds
that missing **test → feature** map (#1950).

It **statically introspects** the test modules with the stdlib `ast` module (the
same stdlib-only approach as the testid catalog) rather than importing them, so
it runs anywhere — no `.venv`, no dependencies, no app build. It emits Markdown +
JSON at `tests/system/test-inventory.{md,json}` (local, git-ignored artifacts,
regenerated — never committed, for the same per-branch staleness reason as the
testid catalog, #1528):

```sh
python scripts/build-test-inventory.py            # rewrite the local .md + .json
python scripts/build-test-inventory.py --stdout    # print markdown, no write
python scripts/build-test-inventory.py --json      # print json, no write
```

Each test is mapped to:

- **feature** (category) — the `test_<feature>.py` filename stem, or an explicit
  `@pytest.mark.category("ssh")` override on the test / class / module
  `pytestmark` (use it to roll several files up under one feature, e.g. the
  `test_ssh_*.py` suites under `ssh`).
- **lane** — `manual` when the `manual` marker applies, else `automated`.
- **platforms** — `linux` / `macos` / `windows`; narrowed (best-effort) from a
  recognized `skipif` gate such as `skip_on_non_windows` or
  `sys.platform == 'darwin'`.

The **"Features with no coverage"** section flags entries in the generator's
curated `FEATURE_AREAS` map that have **no** automated and **no** manual test —
that map is the source of truth for _"what features do we track"_, so add a row
there when you add a feature. A **"Categories not mapped to a feature area"**
section guards against the map drifting behind new suites. The report also runs
as an advisory, **non-blocking** CI step (it never fails the build on a gap).
Grouping/gap logic is unit-tested in `tests/test_test_inventory.py`.

## Setup (manual, if you prefer)

```sh
cd tests/system
uv sync              # create .venv and install the locked dependency set
```

The dependencies live in `pyproject.toml` (pinned in `uv.lock`): `tftpy` (a real
TFTP client for the SVC-13 transfer check) and `pyftpdlib` (an in-process FTP
server used only by the app-independent `test_transfer_checkers.py` tests). The
Embedded Services FTP check itself relies only on the always-present stdlib
`ftplib`. After changing a dependency, run `uv lock` to refresh the lockfile.

All commands below run from `tests/system/`. They use `uv run pytest`, which
keeps the env in sync from `uv.lock` automatically; after a `uv sync` you can
also invoke `./.venv/bin/python -m pytest` directly, or `source
.venv/bin/activate` and just write `pytest`.

## Test groups

Tests split into two groups via the `integration` marker. **Only the
`integration` group launches the real app** — the rest run against a fake app, so
no window or terminal ever appears (that is expected, not a failure).

| Group       | Files                                    | Launches the real app?         | Needs a build?                 |
| ----------- | ---------------------------------------- | ------------------------------ | ------------------------------ |
| machinery   | `test_protocol.py`, `test_roundtrip.py`  | ❌ No — drives a **fake app**  | No — runs anywhere             |
| integration | `test_app_lifecycle.py` (`@integration`) | ✅ Yes — the built desktop app | Yes — `pnpm tauri build` first |

The **machinery** tests exercise the harness plumbing (bridge server, response
correlation, `Driver`, sequential connections) against a `FakeApp` — a Python
WebSocket client that stands in for the in-app bridge. They are fast and need no
build, but they **do not** start the app or a terminal. A name containing
`fake_app` is the giveaway.

> 💡 **Want to see the real app launch?** Run an **`integration`** test
> (`pytest -m integration -v -s`). It opens the app window briefly (~2 s — the
> test kills it on teardown, and the kill/restart step launches it twice), and
> `-s` streams the app's logs (`Test bridge WebSocket transport enabled`,
> `Spawning local shell`, …) as proof it ran.

Integration tests **auto-skip** when the app/agent binaries are not built, so a
plain `pytest` never errors for a missing build — it just skips them.

## Listing tests

```sh
uv run pytest --collect-only -q     # every test id
uv run pytest --markers             # marker groups (incl. integration)
```

## Running everything

```sh
uv run pytest           # all (integration auto-skips if not built)
uv run pytest -v        # one line per test
```

## Running specific suites / tests

```sh
# Only the fast machinery suite (fake app, no build, no window), by marker:
uv run pytest -m "not integration"

# Only the integration suite (launches the real app; build it first), by marker:
uv run pytest -m integration

# A single file:
uv run pytest tests/test_roundtrip.py

# A single test by node id:
uv run pytest tests/test_app_lifecycle.py::test_app_lifecycle

# By name substring (matches across files):
uv run pytest -k restart
uv run pytest -k "roundtrip or protocol"
```

## Running the integration suite

```sh
pnpm tauri build                         # from the repo root — build the app once
cargo build --release -p termihub-agent  # only needed for agent tests
cd tests/system
uv run pytest -m integration -v -s
```

### Faster loop: build a debug app

The harness resolves the app binary in order: **`TERMIHUB_TEST_APP_BINARY`**
override → **release** (`pnpm tauri build`) → **debug** (`pnpm tauri build
--debug`). A debug build is much faster to rebuild, so the
frontend-change → run loop is far tighter:

```sh
pnpm tauri build --debug                 # quicker than a release build
cd tests/system && ./pytest.sh -m integration -k sftp_infra -x -s
```

Point at an arbitrary binary (e.g. a bundle in a non-standard location) with
`TERMIHUB_TEST_APP_BINARY=/path/to/termihub`.

### Failure artifacts

When an **integration** test fails, the harness writes a diagnostic bundle to
`tests/system/artifacts/<nodeid>/` (git-ignored) — `state.json` (the store
snapshot), `terminal.txt` (the terminal buffer), and `app.log` (the captured app
stdout/stderr). This makes a CI or headless failure debuggable after the app has
been torn down. The path is printed at the end of the failing test.

## Useful flags

| Flag      | Effect                                                   |
| --------- | -------------------------------------------------------- |
| `-v`      | one line per test                                        |
| `-s`      | show stdout / app logs live (handy for `-m integration`) |
| `-x`      | stop at the first failure                                |
| `--lf`    | re-run only the last-failed tests                        |
| `-k EXPR` | filter by name substring / expression                    |
| `-m EXPR` | filter by marker (`integration` / `"not integration"`)   |

The quickest daily loop is `pytest -m "not integration"` (instant, no build); run
the full `pytest` after a `tauri build` when you want the real-app lifecycle check.

## Writing a new test

Integration suites subclass **`SystemTest`** (from `termihub_harness`), a thin
base that owns the per-suite lifecycle, the `wait` polling primitive, and the
`delay4user` watch-along hook. Everything that _drives the UI_ lives in focused,
composable **`*Ui` mixins** (issue #831); a suite lists exactly the ones it needs
ahead of `SystemTest` in its bases, so each file declares what it touches and
stays within the size guideline. Add the file under `tests/` and mark it
`integration` — pytest discovers `test_*.py` automatically.

```python
# tests/test_my_feature.py
import pytest

from termihub_harness import SystemTest, TerminalUi

pytestmark = pytest.mark.integration  # auto-skips when the app is not built


class TestMyFeature(TerminalUi, SystemTest):
    def test_echo_runs_in_a_shell(self):
        self.ensure_terminal()                      # open a terminal, wait for the prompt
        self.run_command("echo hello-world")        # type a command (newline appended)
        assert "hello-world" in self.wait_for_output("hello-world")

    def test_state_is_introspectable(self):
        # Runs against the SAME app instance as the test above.
        assert isinstance(self.driver.get_state(), dict)

    def test_survives_a_restart(self):
        self.restart_app()                          # kill + relaunch, driver re-acquired
        self.ensure_terminal()
        self.run_command("echo after-restart")
        assert "after-restart" in self.wait_for_output("after-restart")
```

### How a suite runs (per-suite clean environment)

```
class setup ──► test_a ──► test_b ──► … ──► class teardown
  • fresh isolated config dir                  • kill the app
  • launch the app once                        • close the bridge
  • acquire self.driver                         • remove the config dir
        (tests share this one instance, run in order)
```

Each **suite (class)** gets a clean app set up once and shared by its tests; the
next suite gets its own fresh app. Use a **new class** to force a clean app/state;
use a **new method in the same class** to keep running in the existing instance.

### What `SystemTest` (the base) gives you

| Member                                     | Purpose                                            |
| ------------------------------------------ | -------------------------------------------------- |
| `self.driver` / `self.app` / `self.bridge` | the suite's live `Driver` / app / bridge           |
| `self.wait(predicate, *, timeout, what)`   | poll until truthy (retries on `BridgeError`)       |
| `self.restart_app()`                       | kill + relaunch, re-acquiring `self.driver`        |
| `self.delay4user(seconds, reason)`         | watch-along sleep — only runs under `--delay4user` |

### UI-helper mixins (opt in per suite)

List the mixins a suite drives ahead of `SystemTest`, e.g.
`class TestX(ConnectionsUi, TabsUi, SystemTest):`. Some mixins call into others
at runtime (noted below), so include the dependencies too — they compose freely
because each only borrows `self.driver` / `self.wait` from the base.

| Mixin              | Drives                                                                  | Also needs              |
| ------------------ | ----------------------------------------------------------------------- | ----------------------- |
| `TerminalUi`       | `ensure_terminal` / `run_command` / `wait_for_output` / `has_terminal`  | —                       |
| `TabsUi`           | `tab_count` / `find_tab` / `active_tab` / `switch_to_tab` / `close_tab` | —                       |
| `LayoutUi`         | `leaf_count` (splits) / `set_sidebar_visible`                           | `TerminalUi`            |
| `SidebarUi`        | `switch_to_files_sidebar` / `switch_to_connections_sidebar`             | —                       |
| `ConnectionsUi`    | connection editor + connection-list flows (`create_ssh_connection`, …)  | —                       |
| `PasswordPromptUi` | `handle_password_prompt` / `cancel_password_prompt`                     | —                       |
| `SshUi`            | `connect_ssh_password` (one-call connect)                               | Connections/Prompt/Term |
| `MonitoringUi`     | `monitoring_visible` / `wait_for_monitoring_stats` / refresh / dropdown | —                       |
| `SftpUi`           | `connect_sftp_browser` / `file_browser_path`                            | `SidebarUi`/`Prompt`    |
| `SettingsUi`       | `open_settings_tab` / `open_settings_category` / experimental toggle    | `SidebarUi`             |

The plain name→element lookups (`find_connection` / `find_folder`) stay free
functions in `termihub_harness.ui` so they remain unit-testable without an app.

### Tests that need container fixtures (SSH/serial/telnet)

The infrastructure suites reuse the **containers in
[`tests/docker/docker-compose.yml`](../docker/docker-compose.yml)** as black-box
fixtures — only the driver changed, the containers stay (epic #799). The harness
owns bringing them up: depend on the session-scoped **`ssh_fixtures`** fixture
(`@pytest.mark.usefixtures("ssh_fixtures")` on the class) and it runs
`<runtime> compose up -d ssh-password ssh-keys` once per session, then waits for
each published SSH port to accept a connection. When no container runtime is
available the suite **skips cleanly** rather than failing, so a plain `pytest`
still works on a machine without one.

**Docker or Podman** — the runtime is detected like `scripts/test-system-linux.sh`:
a `CONTAINER_CMD` env override wins; otherwise Docker is preferred and Podman is
the fallback, choosing whichever CLI exists _and_ whose daemon/machine answers
`<cmd> info`. (Readiness is a TCP port probe, not `compose --wait`, because
Podman's compose provider may not support that flag.) Force a runtime with
`CONTAINER_CMD=podman`.

> **Compose version:** `tests/docker/docker-compose.yml` uses build
> `additional_contexts`, which needs **Docker Compose v2.17+** (or a Podman
> compose provider of similar vintage). An older Compose rejects the file with
> `Additional property additional_contexts is not allowed` — the suite surfaces
> that exact message in its skip reason. Update Docker Desktop / the compose
> plugin if you hit it.

Telnet works the same way: depend on **`telnet_fixtures`** to bring up the
`telnet-server` container (`TELNET_PORT` 2301). The **serial** editor-UI suite
(`test_serial.py`) needs **no** container — its live-I/O scenarios are manual
(the port field is a detection-only `<select>` a virtual PTY can't be selected
through; see the module docstring and `docs/testing.md` → `MT-SER-09`).

Coordinates live in `termihub_harness` as constants: `SSH_PASSWORD_PORT` (2201),
`SSH_KEYS_PORT` (2203), `SSH_USERNAME` / `SSH_PASSWORD`, `SSH_KEY_PATH`, and
`TELNET_HOST` / `TELNET_PORT` (2301). To run the SSH suite live:

```sh
# Docker:
docker compose -f tests/docker/docker-compose.yml up -d ssh-password ssh-keys
# …or Podman (e.g. on Windows where Docker is unavailable):
podman compose -f tests/docker/docker-compose.yml up -d ssh-password ssh-keys

pnpm tauri build            # the app must include the bridge verbs the test uses
cd tests/system && ./pytest.sh -m integration -k ssh -v -s   # or pytest.cmd on Windows
# (the harness can also bring the containers up itself; CONTAINER_CMD=podman forces Podman)
```

> The SSH connection-failure case needs **no** server, so it is not gated on
> `ssh_fixtures` and runs even without a container runtime (it still needs the
> built app).

### Watch-along mode (`--delay4user`)

Sprinkle `self.delay4user(seconds, reason="…")` wherever following along by eye
matters, setting the duration per call (longer for changes that are hard to
spot). It is a **no-op by default**, so CI, AI-agent, and normal runs skip every
delay and run at full speed. To actually watch the UI, add the boolean flag:

```sh
# insert the delays so a human can see each step (use -s to also see the app):
uv run pytest -m integration --delay4user -s
```

Each delay prints `⏸  delay4user: sleeping 2.0s — <reason>` so it is clear what
is being shown.

### Guided-manual tests (`--manual`)

Some checks are irreducibly manual — a native OS dialog, xterm-canvas color
fidelity, cursor blink — but the _setup_ around them is fully automatable. A
**guided-manual test** is a normal `pytest` test that does all the automatable
work through the usual mixins, then calls an operator prompt for just the human
bit. Mark the suite (or method) `@pytest.mark.manual` and mix in `ManualUi`:

```python
@pytest.mark.integration
@pytest.mark.manual
class TestExport(ConnectionsUi, ManualUi, SystemTest):
    def test_export_native_dialog(self):
        self.create_local_connection(unique_name("demo"))   # harness setup
        self.manual_step(                                    # the human bit
            "Use the sidebar ⋯ menu → Export Connections and save the file.",
            "A native Save dialog appears and writes a JSON file.",
        )
```

Operator verbs on `ManualUi`:

| Call                                   | Behavior                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| `self.manual_step(instr, expected)`    | print, wait for Enter, ask pass/fail/skip; fail → test fails |
| `self.manual_confirm(question)`        | yes/no prompt → `bool`                                       |
| `self.manual_observe(instr, expected)` | like `manual_step`, attaches a screenshot once #900 lands    |

**Skip-by-default.** Without `--manual` (or with no interactive TTY) these tests
**skip** with a clear reason, so CI / AI-agent / normal runs stay green. Run a
single guided test interactively (use `-s` so the prompts reach your console):

```sh
./pytest.sh --manual -k native_dialog -s
# select a different platform's platform-scoped items:
./pytest.sh --manual --manual-platform=windows -s
```

A `manual-<ts>-<platform>-<arch>.{json,md}` report (pass/fail/skip + notes,
platform, timestamps) is written to [`tests/reports/`](../reports/) at the end of
the session. See the worked examples in
[`tests/test_manual_examples.py`](tests/test_manual_examples.py). This subsumes
the standalone `scripts/test-manual.py` + `tests/manual/*.yaml` runner, which is
being migrated incrementally (epic #913).

Tips:

- **Find `data-testid`s** in the React components (`src/**`), the
  [`testid-catalog.md`](testid-catalog.md), or the selector constants reused by
  the harness mixins (`termihub_harness/ui/`).
- **Read app state** with `self.driver.get_state("some.dot.path")` to assert on
  the Zustand store (e.g. `activePanelId`).
- **Fast tests without a build** — to exercise harness/protocol behavior, drive a
  `FakeApp` instead (no `SystemTest`, no `integration` marker); see
  `tests/test_roundtrip.py`.
- **Lower-level control** — the function-scoped `bridge` / `app` / `agent`
  fixtures (in `conftest.py`) are still available for one-off tests that want to
  manage launch ordering themselves instead of subclassing `SystemTest`.

## Driver verbs

`click`, `type`, `select`, `context_menu`, `press_key`, `terminal_input`,
`exists`, `get_text`, `get_attribute`, `read_terminal`, `get_state`,
`screenshot` — the same vocabulary as the TypeScript `Driver`. `screenshot`
returns a PNG data URL of the rendered app (DOM rasterization; see
[`docs/test-bridge.md`](../../docs/test-bridge.md#screenshots-screenshot)) and is
also written into the failure-artifact bundle as `screenshot.png`.

UI elements with UUID `data-testid`s (connections, folders) are resolved by
**name** through `getState` via the `termihub_harness.ui` helpers (`find_connection`,
`find_folder`) and the `ConnectionsUi` suite mixin — the bridge-native analog of
the old WebdriverIO find-by-title lookups. Tab lookups use the `TabsUi` mixin's
`find_tab` / `tab_count`.

## Orchestration

- `AppInstance(config_dir?)` — `start(bridge_port)`, `stop()`, `restart()`. Config
  dir is stable across a restart so the saved last-session survives. On Windows
  each instance pins its WebView2 user-data folder (via `WEBVIEW2_USER_DATA_FOLDER`)
  so `stop()` can reap the `msedgewebview2.exe` hosts, which live outside the app
  process tree and would otherwise leak across back-to-back runs (issue #1022).
- `AgentInstance(host?, port?)` — `start()`, `stop()`, `restart()` for a
  `termihub-agent --listen` process, with process-tree teardown via `psutil`.

> **Note — agent↔app integration.** The harness can start/kill/restart an agent
> process, but the **desktop app currently connects to agents only over SSH**
> (not direct TCP). A full app↔agent reconnection test therefore needs an SSH
> fixture (a local sshd or the Docker SSH container) with the agent reachable
> there. That is tracked as a follow-up; the lifecycle test here covers the
> app's own kill/restart/reconnect.
