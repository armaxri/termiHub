"""Unit tests for the per-app PSReadLine history isolation (#5055)."""

from __future__ import annotations

from pathlib import Path

from termihub_harness import orchestrator, psreadline
from termihub_harness.psreadline import HISTORY_ENV, SHELL_ENV_KEEP_ENV, SHIM_DIR

DOCS = r"C:\Users\me\Documents"
PWSH_PERSONAL = DOCS + r"\PowerShell\Modules"
WINPS_PERSONAL = DOCS + r"\WindowsPowerShell\Modules"
WINPS_SHARED = r"C:\Program Files\WindowsPowerShell\Modules"
WINPS_SYSTEM = r"C:\Windows\system32\WindowsPowerShell\v1.0\Modules"


def _entries(value: str) -> list[str]:
    return value.split(";")


def test_shim_module_is_shipped():
    assert (SHIM_DIR / "PSReadLine" / "PSReadLine.psm1").is_file()


def test_off_windows_nothing_changes(tmp_path: Path):
    assert psreadline.app_env(tmp_path, {}, system="Linux") == {}
    assert psreadline.app_env(tmp_path, {}, system="Darwin") == {}
    assert not (tmp_path / "psreadline").exists()


def test_history_file_is_inside_the_instance(tmp_path: Path):
    env = psreadline.app_env(tmp_path, {}, system="Windows", documents=DOCS)
    history = Path(env[HISTORY_ENV])
    assert history == tmp_path / "psreadline" / "ConsoleHost_history.txt"
    assert history.parent.is_dir()


def test_local_shells_are_told_to_keep_the_module_path(tmp_path: Path):
    # portable-pty would otherwise put the registry's PSModulePath back.
    env = psreadline.app_env(tmp_path, {}, system="Windows", documents=DOCS)
    assert env[SHELL_ENV_KEEP_ENV] == "PSModulePath"


def test_two_instances_get_different_history_files(tmp_path: Path):
    a = psreadline.app_env(tmp_path / "a", {}, system="Windows", documents=DOCS)
    b = psreadline.app_env(tmp_path / "b", {}, system="Windows", documents=DOCS)
    assert a[HISTORY_ENV] != b[HISTORY_ENV]


def test_module_path_puts_the_shim_then_the_personal_folders_first():
    # PowerShell 7 then inserts its shared and $PSHOME folders right after its
    # personal one, so the shim is the only thing ahead of its usual order.
    value = psreadline.module_path(f"{WINPS_SHARED};{WINPS_SYSTEM}", DOCS)
    assert _entries(value) == [
        str(SHIM_DIR),
        PWSH_PERSONAL,
        WINPS_PERSONAL,
        WINPS_SHARED,
        WINPS_SYSTEM,
    ]


def test_module_path_drops_duplicates_and_empty_entries():
    inherited = f"{PWSH_PERSONAL.upper()}\\;;{WINPS_SHARED};{WINPS_SHARED}"
    value = psreadline.module_path(inherited, DOCS)
    assert _entries(value) == [str(SHIM_DIR), PWSH_PERSONAL, WINPS_PERSONAL, WINPS_SHARED]


def test_module_path_with_nothing_inherited():
    assert _entries(psreadline.module_path("", DOCS)) == [
        str(SHIM_DIR),
        PWSH_PERSONAL,
        WINPS_PERSONAL,
    ]


def test_app_env_keeps_the_inherited_module_path(tmp_path: Path):
    env = psreadline.app_env(
        tmp_path, {"PSModulePath": WINPS_SYSTEM}, system="Windows", documents=DOCS
    )
    assert _entries(env["PSModulePath"])[0] == str(SHIM_DIR)
    assert _entries(env["PSModulePath"])[-1] == WINPS_SYSTEM


def test_app_env_reuses_the_inherited_key_spelling(tmp_path: Path):
    # os.environ upper-cases names on Windows; a second spelling of the same
    # variable would reach the app as a second, conflicting entry.
    env = psreadline.app_env(
        tmp_path, {"PSMODULEPATH": WINPS_SYSTEM}, system="Windows", documents=DOCS
    )
    assert "PSModulePath" not in env
    assert _entries(env["PSMODULEPATH"])[-1] == WINPS_SYSTEM


def _instance(monkeypatch, tmp_path: Path, system: str, **kwargs):
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: tmp_path / "app.exe")
    monkeypatch.setattr(orchestrator.platform, "system", lambda: system)
    monkeypatch.setattr(psreadline, "_documents_dir", lambda: DOCS)
    return orchestrator.AppInstance(config_dir=tmp_path, **kwargs)


def test_windows_app_launches_with_its_own_history(tmp_path, monkeypatch):
    monkeypatch.setenv("PSModulePath", WINPS_SYSTEM)
    env = _instance(monkeypatch, tmp_path, "Windows").launch_env()
    assert env[HISTORY_ENV] == str(tmp_path / "psreadline" / "ConsoleHost_history.txt")
    keys = [k for k in env if k.upper() == "PSMODULEPATH"]
    assert len(keys) == 1
    assert _entries(env[keys[0]])[0] == str(SHIM_DIR)
    assert _entries(env[keys[0]])[-1] == WINPS_SYSTEM


def test_other_platforms_launch_without_the_shim(tmp_path, monkeypatch):
    monkeypatch.delenv("PSModulePath", raising=False)
    env = _instance(monkeypatch, tmp_path, "Linux").launch_env()
    assert HISTORY_ENV not in env
    assert SHELL_ENV_KEEP_ENV not in env
    assert "PSModulePath" not in env


def test_a_suite_can_override_the_history(tmp_path, monkeypatch):
    own = str(tmp_path / "suite-history.txt")
    instance = _instance(monkeypatch, tmp_path, "Windows", extra_env={HISTORY_ENV: own})
    assert instance.launch_env()[HISTORY_ENV] == own


def test_shell_env_keep_name_matches_the_rust_constant():
    rust = Path(psreadline.__file__).resolve().parents[3] / "src-tauri/src/utils/test_bridge.rs"
    assert (
        f'pub const TEST_SHELL_ENV_KEEP_ENV: &str = "{SHELL_ENV_KEEP_ENV}";'
        in rust.read_text(encoding="utf-8")
    )
