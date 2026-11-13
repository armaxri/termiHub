"""The product run's machinery without an app (#5518): input, record, page server.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from termihub_harness.colors import parse_color
from termihub_harness.product_run import InputError, Recorder, load_inputs, parse_inputs
from termihub_harness.product_run.hosts import (
    ComposeHosts,
    HostUnavailable,
    NativeSshd,
    RunHosts,
    parse_exports,
    target_from_exports,
)
from termihub_harness.product_run.grades import is_sentence_case, mix_with_transparent
from termihub_harness.product_run.recorder import PAGE_TEMPLATE, safe_step_id
from termihub_harness.product_run.server import answer_human, make_server
from termihub_harness.product_run.ui import profile_env, run_dev_name

REPO_ROOT = Path(__file__).resolve().parents[3]


# ── setup input ──────────────────────────────────────────────────────────────
def test_no_file_means_every_input_is_missing(tmp_path):
    inputs = load_inputs(tmp_path / "absent.json")
    assert inputs.get("serial") is None
    assert "serial.device" in inputs.missing("serial")


def test_a_complete_section_is_usable_and_an_incomplete_one_is_missing():
    inputs = parse_inputs(
        {"raspberry_pi": {"host": "pi.local", "user": ""}, "serial": {"device": "/dev/cu.x"}}
    )
    assert inputs.get("serial") == {"device": "/dev/cu.x"}
    assert inputs.missing("serial") is None
    assert inputs.get("raspberry_pi") is None  # user is empty
    assert "raspberry_pi.host, raspberry_pi.user" in inputs.missing("raspberry_pi")


@pytest.mark.parametrize(
    "doc, message",
    [
        ({"printer": {}}, "unknown section"),
        ({"rdp": {"host": "h", "password": "x"}}, "secrets do not belong"),
        ({"vnc": {"host": "h", "colour": 1}}, "unknown key"),
        ([], "JSON object"),
    ],
)
def test_bad_input_is_refused(doc, message):
    with pytest.raises(InputError, match=message):
        parse_inputs(doc)


def test_the_committed_example_parses():
    example = REPO_ROOT / "product-run.local.json.example"
    inputs = load_inputs(example)
    assert set(inputs.summary()["configured"]) == {"raspberry_pi", "serial", "rdp", "vnc"}


# ── profile isolation ────────────────────────────────────────────────────────
def test_profile_env_redirects_every_shell_location(tmp_path):
    env = profile_env(tmp_path, "product-run-x")
    for key in ("HOME", "ZDOTDIR", "HISTFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
        assert env[key].startswith(str(tmp_path)), key
    assert env["TERMIHUB_DEV_NAME"] == "product-run-x"


def test_dev_name_fits_the_keychain_namespace_cap(tmp_path, monkeypatch):
    monkeypatch.delenv("TERMIHUB_PRODUCT_RUN_DEV_NAME", raising=False)
    name = run_dev_name(tmp_path / "20261113T101500Z")
    assert name == "product-run-20261113T101500Z" and len(name) <= 32


# ── live record ──────────────────────────────────────────────────────────────
def _recorder(tmp_path) -> Recorder:
    rec = Recorder(tmp_path / "run", clock=lambda: "2026-11-13T00:00:00Z")
    rec.start(run_id="run", inputs={}, profile={"dev_name": "product-run-run"})
    return rec


def test_steps_are_recorded_with_status_summary_and_js_mirror(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("a.one", "One", phase="p", expect="a dialog")
    rec.evidence("a.one", "measured 4.9:1")
    rec.end("a.one", "pass")
    rec.not_tested("a.two", "Two", phase="p", reason="no serial.device")
    doc = rec.load()
    assert [s["status"] for s in doc["steps"]] == ["pass", "not-tested"]
    assert doc["steps"][0]["evidence"] == ["measured 4.9:1"]
    assert doc["summary"]["pass"] == 1 and doc["summary"]["not-tested"] == 1
    js = (rec.run_dir / "status.js").read_text(encoding="utf-8")
    assert js.startswith("window.__productRun(") and '"a.two"' in js
    assert (rec.run_dir / "index.html").read_text(encoding="utf-8") == PAGE_TEMPLATE.read_text(
        encoding="utf-8"
    )


def test_finish_closes_open_steps_and_writes_results(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("a", "A", phase="p")
    doc = rec.finish(exit_status=1)
    assert doc["state"] == "finished" and doc["steps"][0]["status"] == "not-tested"
    results = json.loads((rec.run_dir / "results.json").read_text(encoding="utf-8"))
    assert results["exit_status"] == 1


def test_a_final_status_is_required(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("a", "A", phase="p")
    with pytest.raises(ValueError):
        rec.end("a", "running")


def test_screenshots_never_overwrite_and_land_in_the_manifest(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("checklist/banner", "Banner", phase="p", expect="the banner")
    first = rec.shot_path("checklist/banner")
    first.write_bytes(b"png")
    second = rec.shot_path("checklist/banner")
    assert first.name == "checklist-banner.png" and second.name == "checklist-banner-2.png"
    rec.add_screenshot("checklist/banner", first, {"theme": "dark", "source": "window"})
    manifest = json.loads((rec.shots_dir / "manifest.json").read_text(encoding="utf-8"))
    shot = manifest["shots"][0]
    assert shot["file"] == "shots/checklist-banner.png" and shot["expect"] == "the banner"
    assert rec.load()["steps"][0]["screenshots"] == ["shots/checklist-banner.png"]
    assert safe_step_id("../x") == "x"


def test_a_human_answer_file_ends_the_wait(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("h", "Human", phase="p")
    token = rec.request_human("h", "click Allow", "the dialog closes")
    assert rec.load()["human"]["token"] == token and rec.step_status("h") == "human"
    (rec.human_dir / f"{token}.json").write_text('{"result": "done"}', encoding="utf-8")
    assert rec.wait_human(token, timeout=2, poll=0.05) == {"result": "done"}
    assert rec.load()["human"] is None


def test_an_unanswered_human_step_times_out(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("h", "Human", phase="p")
    token = rec.request_human("h", "unplug", "it reconnects")
    assert rec.wait_human(token, timeout=0.2, poll=0.05) is None


# ── page server ──────────────────────────────────────────────────────────────
def test_only_the_open_prompt_can_be_answered(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("h", "Human", phase="p")
    token = rec.request_human("h", "click Allow", "closed")
    assert answer_human(rec.run_dir, {"token": "stale", "result": "done"})[0] == 409
    assert answer_human(rec.run_dir, {"token": token, "result": "maybe"})[0] == 400
    assert answer_human(rec.run_dir, {"token": token, "result": "failed", "note": "no"})[0] == 200
    answer = json.loads((rec.human_dir / f"{token}.json").read_text(encoding="utf-8"))
    assert answer == {"result": "failed", "note": "no"}


def test_server_serves_the_page_and_records_done(tmp_path):
    rec = _recorder(tmp_path)
    rec.begin("h", "Human", phase="p")
    token = rec.request_human("h", "click Allow", "closed")
    server = make_server(rec.run_dir)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    try:
        with urllib.request.urlopen(base + "index.html", timeout=5) as resp:
            assert b"status.js" in resp.read()
        request = urllib.request.Request(
            base + "api/human",
            data=json.dumps({"token": token, "result": "done"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=5) as resp:
            assert json.loads(resp.read())["ok"] is True
        with pytest.raises(urllib.error.HTTPError):
            urllib.request.urlopen(base + "api/other", data=b"{}", timeout=5)
    finally:
        server.shutdown()
        server.server_close()
    assert rec.wait_human(token, timeout=1, poll=0.05) == {"result": "done", "note": ""}


# ── grades ───────────────────────────────────────────────────────────────────
def test_sentence_case_rule():
    assert is_sentence_case("Backup & restore") and is_sentence_case("X server")
    assert is_sentence_case("Right-click behavior")
    assert not is_sentence_case("Backup & Restore") and not is_sentence_case("font family")


def test_color_mix_with_transparent_is_the_colour_at_that_alpha():
    tint = mix_with_transparent("color-mix(in srgb, #227bba 10%, transparent)")
    base = parse_color("#227bba")
    assert (tint.r, tint.g, tint.b) == (base.r, base.g, base.b) and abs(tint.a - 0.1) < 1e-9
    assert mix_with_transparent("#ffffff") == parse_color("#ffffff")


# ── SSH hosts (#5535) ────────────────────────────────────────────────────────
_FIXTURE_OUT = """native-sshd: sshd listening on 127.0.0.1:22400 (pid 1, state /s)
export TERMIHUB_NATIVE_SSHD='1'
export TERMIHUB_NATIVE_SSHD_PORT='22400'
export TERMIHUB_NATIVE_SSHD_USER='arne'
export TERMIHUB_NATIVE_SSHD_KEY='/s/client key'
export TERMIHUB_NATIVE_SSHD_DIR='/s'
export TERMIHUB_NATIVE_SSHD_HOME='/s/home'
export TERMIHUB_NATIVE_SSHD_JUMP_PORT='22401'
"""


def test_fixture_exports_parse_into_a_target_without_password():
    exports = parse_exports(_FIXTURE_OUT)
    assert exports["TERMIHUB_NATIVE_SSHD_KEY"] == "/s/client key"  # shell-unquoted
    assert "native-sshd:" not in "".join(exports)  # log lines ignored
    target = target_from_exports(exports)
    assert (target.port, target.username, target.jump_port) == (22400, "arne", 22401)
    assert target.password == "" and target.key == "/s/client key"
    native = NativeSshd(target=target, exports=exports)
    assert native.session_home == Path("/s/home")
    assert native.client_key == Path("/s/client key")


def test_fixture_exports_missing_the_port_are_refused():
    with pytest.raises(HostUnavailable, match="TERMIHUB_NATIVE_SSHD_PORT"):
        target_from_exports({"TERMIHUB_NATIVE_SSHD_USER": "u", "TERMIHUB_NATIVE_SSHD_DIR": "/s"})


def test_a_docker_host_that_is_not_up_is_missing_with_its_reason():
    hosts = ComposeHosts(up={"ssh-password"}, reasons={"ssh-mfa": "no container runtime"})
    assert hosts.missing("ssh-password") is None
    assert hosts.missing("ssh-mfa") == "no container runtime"
    assert "ssh-other" in hosts.missing("ssh-other")


def test_without_a_private_agent_the_app_never_gets_the_users_agent():
    env = RunHosts().app_env()
    assert set(env) == {"SSH_AUTH_SOCK"}
    assert env["SSH_AUTH_SOCK"].startswith("/nonexistent/")
