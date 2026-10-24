"""Unit tests of the OS credential store reader and the file lock (#4929).

No app: the parsers run on captured tool output, and the throwaway Linux store
and the file lock run for real where the platform has them.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

from termihub_harness import locked_file, os_store

_DUMP = """\
keychain: "/tmp/x/termihub-system-test.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="conn-a:password@termiHub"
    "acct"<blob>="conn-a:password"
    "svce"<blob>="termiHub"
keychain: "/tmp/x/termihub-system-test.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="0f0e-uuid"
    "svce"<blob>="termiHub-backup-restore"
keychain: "/tmp/x/termihub-system-test.keychain-db"
version: 512
class: "inet"
attributes:
    "acct"<blob>="someone"
    "svce"<blob>=<NULL>
"""

_SEARCH = """\
[/org/freedesktop/secrets/collection/login/1]
label = conn-a:password@termiHub:default (keyring v3.6.3)
secret = s3cret
created = 2026-10-24 10:00:00
modified = 2026-10-24 10:00:00
schema = org.freedesktop.Secret.Generic
attribute.application = rust-keyring
attribute.service = termiHub
attribute.target = default
attribute.username = conn-a:password
[/org/freedesktop/secrets/collection/login/2]
attribute.service = termiHub
attribute.username = conn-b:password
"""


def test_credential_account_and_windows_target_match_the_keyring_crate():
    assert os_store.credential_account("ssh-1") == "ssh-1:password"
    assert os_store.credential_account("ssh-1", "key_passphrase") == "ssh-1:key_passphrase"
    assert os_store.windows_target("termiHub", "ssh-1:password") == "ssh-1:password.termiHub"


def test_parse_keychain_dump_keeps_generic_passwords_only():
    assert os_store.parse_keychain_dump(_DUMP) == [
        {"svce": "termiHub", "acct": "conn-a:password"},
        {"svce": "termiHub-backup-restore", "acct": "0f0e-uuid"},
    ]


def test_parse_secret_tool_search_reads_every_item():
    items = os_store.parse_secret_tool_search(_SEARCH)
    assert [i["username"] for i in items] == ["conn-a:password", "conn-b:password"]
    assert all(i["service"] == "termiHub" for i in items)


@pytest.mark.parametrize(
    ("env", "allowed"),
    [
        ({}, False),
        ({"CI": "true"}, True),
        ({"GITHUB_ACTIONS": "true"}, True),
        ({os_store.OPT_IN_ENV: "1"}, True),
        ({os_store.OPT_IN_ENV: "0"}, False),
    ],
)
def test_macos_swap_runs_only_in_ci_or_on_opt_in(env, allowed):
    assert os_store.macos_swap_allowed(env) is allowed


def test_open_store_refuses_the_macos_swap_outside_ci(monkeypatch):
    for name in ("CI", "GITHUB_ACTIONS", os_store.OPT_IN_ENV):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(os_store.OsStoreUnavailable, match="per-user default keychain"):
        os_store.open_store("darwin")


def test_open_store_names_an_unknown_platform():
    with pytest.raises(os_store.OsStoreUnavailable, match="plan9"):
        os_store.open_store("plan9")


_LINUX_TOOLS = ("dbus-daemon", "gnome-keyring-daemon", "secret-tool")


@pytest.mark.skipif(
    not sys.platform.startswith("linux") or any(shutil.which(t) is None for t in _LINUX_TOOLS),
    reason="needs Linux with dbus-daemon, gnome-keyring and secret-tool",
)
def test_private_gnome_keyring_round_trips_and_is_torn_down():
    store = os_store.SecretServiceStore()
    runtime = store._runtime
    try:
        env = store.tool_env()
        assert env["DBUS_SESSION_BUS_ADDRESS"] != os.environ.get("DBUS_SESSION_BUS_ADDRESS")
        assert store.app_env() == {"DBUS_SESSION_BUS_ADDRESS": env["DBUS_SESSION_BUS_ADDRESS"]}
        os_store._run(
            ["secret-tool", "store", "--label", "t", "service", "termiHub", "username", "a:password"],
            env=env,
            stdin="value-1",
        )
        assert store.accounts() == {"a:password"}
        assert store.value("a:password") == "value-1"
        store.delete("a:password")
        assert not store.exists("a:password")
    finally:
        store.close()
    assert not runtime.exists()


def _replace_fails(path: Path) -> bool:
    other = path.with_name("staged.json")
    other.write_text("{}", encoding="utf-8")
    try:
        os.replace(other, path)
    except OSError:
        return True
    return False


def test_locked_file_cannot_be_replaced_and_is_unlocked_after(tmp_path):
    target = tmp_path / "connections.json"
    target.write_text('{"version": 1}', encoding="utf-8")
    try:
        lock = locked_file.locked(target)
        lock.__enter__()
    except locked_file.LockUnavailable as exc:
        pytest.skip(f"cannot lock a file here: {exc}")
    try:
        assert target.read_text(encoding="utf-8") == '{"version": 1}', "must stay readable"
        assert _replace_fails(target), "a locked file was replaced"
    finally:
        lock.__exit__(None, None, None)
    assert not _replace_fails(target), "the file stayed locked"


def test_locked_file_refuses_a_missing_file(tmp_path):
    with pytest.raises(locked_file.LockUnavailable, match="not a file"):
        locked_file.locked(tmp_path / "missing.json")


def test_secret_tool_usernames_survive_split_streams():
    # Ubuntu's secret-tool prints item headers on stdout, attributes on stderr.
    stdout = "[/1]\nlabel = a\nsecret = x\n[/2]\nlabel = b\nsecret = y\n"
    stderr = (
        "attribute.service = termiHub\nattribute.username = conn-a:password\n"
        "attribute.service = termiHub\nattribute.username = conn-b:password\n"
    )
    assert os_store.parse_secret_tool_usernames(stdout + "\n" + stderr) == {
        "conn-a:password",
        "conn-b:password",
    }
