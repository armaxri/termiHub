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

Tests split into two groups via the `integration` marker:

| Group       | Files                                    | Needs a build?                   |
| ----------- | ---------------------------------------- | -------------------------------- |
| machinery   | `test_protocol.py`, `test_roundtrip.py`  | No — run anywhere via a fake app |
| integration | `test_app_lifecycle.py` (`@integration`) | Yes — `pnpm tauri build` first   |

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
# Only the fast machinery suite (no build), by marker:
./.venv/bin/python -m pytest -m "not integration"

# Only the integration suite (build the app first), by marker:
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
