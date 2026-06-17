# termiHub Python system-test harness

System/integration tests that drive the **real built app** over the
cross-platform WebSocket test bridge and own the lifecycle of the app and agent
processes. They run identically on Linux, Windows, and macOS — including macOS,
where the WebDriver-based E2E path cannot (no WKWebView driver; see ADR-5).

This is the Python side of the test architecture: a black-box client of the app
over the bridge protocol (issue #801). The bridge command vocabulary is the
contract, kept in parity with the TypeScript dispatcher (`src/testbridge/`). See
[`docs/test-bridge.md`](../../docs/test-bridge.md) for the protocol.

## Layout

| Path                               | Responsibility                                        |
| ---------------------------------- | ----------------------------------------------------- |
| `termihub_harness/protocol.py`     | Wire envelope encode/decode (mirrors `wsProtocol.ts`) |
| `termihub_harness/bridge.py`       | WebSocket bridge server + synchronous `Driver`        |
| `termihub_harness/orchestrator.py` | `AppInstance` / `AgentInstance` process lifecycle     |
| `tests/`                           | pytest tests + `fake_app.py` (a WS client stand-in)   |
| `conftest.py`                      | `bridge` / `app` / `agent` fixtures                   |

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

## Setup (once)

```sh
cd tests/system
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

All commands below run from `tests/system/`. They use `./.venv/bin/python -m
pytest`; if you `source .venv/bin/activate` first, you can drop that prefix and
just write `pytest`.

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
./.venv/bin/python -m pytest --collect-only -q     # every test id
./.venv/bin/python -m pytest --markers             # marker groups (incl. integration)
```

## Running everything

```sh
./.venv/bin/python -m pytest           # all (integration auto-skips if not built)
./.venv/bin/python -m pytest -v        # one line per test
```

## Running specific suites / tests

```sh
# Only the fast machinery suite (fake app, no build, no window), by marker:
./.venv/bin/python -m pytest -m "not integration"

# Only the integration suite (launches the real app; build it first), by marker:
./.venv/bin/python -m pytest -m integration

# A single file:
./.venv/bin/python -m pytest tests/test_roundtrip.py

# A single test by node id:
./.venv/bin/python -m pytest tests/test_app_lifecycle.py::test_app_lifecycle

# By name substring (matches across files):
./.venv/bin/python -m pytest -k restart
./.venv/bin/python -m pytest -k "roundtrip or protocol"
```

## Running the integration suite

```sh
pnpm tauri build                         # from the repo root — build the app once
cargo build --release -p termihub-agent  # only needed for agent tests
cd tests/system
./.venv/bin/python -m pytest -m integration -v -s
```

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

Integration suites subclass **`SystemTest`** (from `termihub_harness`). The base
class handles the per-suite lifecycle and provides the polling/terminal helpers,
so a test method is just the steps you care about. Add the file under `tests/`
and mark it `integration` — pytest discovers `test_*.py` automatically.

```python
# tests/test_my_feature.py
import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration  # auto-skips when the app is not built


class TestMyFeature(SystemTest):
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

### What `SystemTest` gives you

| Member                                     | Purpose                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `self.driver` / `self.app` / `self.bridge` | the suite's live `Driver` / app / bridge            |
| `self.wait(predicate, *, timeout, what)`   | poll until truthy (retries on `BridgeError`)        |
| `self.has_terminal()`                      | whether a readable terminal exists                  |
| `self.ensure_terminal()`                   | open a terminal (if needed) and wait for its prompt |
| `self.run_command(cmd)`                    | type a command into the active terminal             |
| `self.wait_for_output(text)`               | poll the terminal until it contains `text`          |
| `self.restart_app()`                       | kill + relaunch, re-acquiring `self.driver`         |
| `self.delay4user(seconds, reason)`         | watch-along sleep — only runs under `--delay4user`  |

### Watch-along mode (`--delay4user`)

Sprinkle `self.delay4user(seconds, reason="…")` wherever following along by eye
matters, setting the duration per call (longer for changes that are hard to
spot). It is a **no-op by default**, so CI, AI-agent, and normal runs skip every
delay and run at full speed. To actually watch the UI, add the boolean flag:

```sh
# insert the delays so a human can see each step (use -s to also see the app):
./.venv/bin/python -m pytest -m integration --delay4user -s
```

Each delay prints `⏸  delay4user: sleeping 2.0s — <reason>` so it is clear what
is being shown.

Tips:

- **Find `data-testid`s** in the React components (`src/**`) or the existing
  selectors in `tests/e2e/helpers/selectors.js`.
- **Read app state** with `self.driver.get_state("some.dot.path")` to assert on
  the Zustand store (e.g. `activePanelId`).
- **Fast tests without a build** — to exercise harness/protocol behavior, drive a
  `FakeApp` instead (no `SystemTest`, no `integration` marker); see
  `tests/test_roundtrip.py`.
- **Lower-level control** — the function-scoped `bridge` / `app` / `agent`
  fixtures (in `conftest.py`) are still available for one-off tests that want to
  manage launch ordering themselves instead of subclassing `SystemTest`.

## Driver verbs

`click`, `type`, `terminal_input`, `exists`, `get_text`, `get_attribute`,
`read_terminal`, `get_state` — the same vocabulary as the TypeScript `Driver`.

## Orchestration

- `AppInstance(config_dir?)` — `start(bridge_port)`, `stop()`, `restart()`. Config
  dir is stable across a restart so the saved last-session survives.
- `AgentInstance(host?, port?)` — `start()`, `stop()`, `restart()` for a
  `termihub-agent --listen` process, with process-tree teardown via `psutil`.

> **Note — agent↔app integration.** The harness can start/kill/restart an agent
> process, but the **desktop app currently connects to agents only over SSH**
> (not direct TCP). A full app↔agent reconnection test therefore needs an SSH
> fixture (a local sshd or the Docker SSH container) with the agent reachable
> there. That is tracked as a follow-up; the lifecycle test here covers the
> app's own kill/restart/reconnect.
