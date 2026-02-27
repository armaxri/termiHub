#!/usr/bin/env python3
"""termiHub Guided Manual Test Runner.

Presents manual test items from tests/manual/*.yaml one at a time,
manages infrastructure (Docker, virtual serial ports), collects
pass/fail/skip results, and writes a JSON report.

Usage:
    python scripts/test-manual.py [OPTIONS]

Requires: Python 3.8+, PyYAML
"""

from __future__ import annotations

import argparse
import atexit
import datetime
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML is required. Install with: pip install pyyaml")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"],
    text=True,
).strip())

TESTS_DIR = REPO_ROOT / "tests" / "manual"
DEFAULT_REPORT_DIR = REPO_ROOT / "tests" / "reports"
DOCKER_COMPOSE = REPO_ROOT / "tests" / "docker" / "docker-compose.yml"

# Platform-specific app binary paths (release builds)
APP_PATHS: dict[str, Path] = {
    "macos": REPO_ROOT / "src-tauri" / "target" / "release" / "bundle" / "macos" / "termiHub.app" / "Contents" / "MacOS" / "termiHub",
    "linux": REPO_ROOT / "src-tauri" / "target" / "release" / "termihub",
    "windows": REPO_ROOT / "src-tauri" / "target" / "release" / "termihub.exe",
}


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

def detect_platform() -> str:
    """Return 'macos', 'linux', or 'windows'."""
    system = platform.system().lower()
    if system == "darwin":
        return "macos"
    if system == "linux":
        return "linux"
    if system == "windows" or "MSYSTEM" in os.environ:
        return "windows"
    return system


def detect_arch() -> str:
    """Return architecture (e.g. 'x86_64', 'aarch64')."""
    machine = platform.machine().lower()
    if machine in ("amd64", "x86_64"):
        return "x86_64"
    if machine in ("arm64", "aarch64"):
        return "aarch64"
    return machine


def detect_os_version() -> str:
    """Return a human-readable OS version string."""
    system = platform.system()
    if system == "Darwin":
        ver = platform.mac_ver()[0]
        return f"macOS {ver}" if ver else "macOS"
    if system == "Linux":
        try:
            import distro  # type: ignore[import-untyped]
            return distro.name(pretty=True)
        except ImportError:
            return f"Linux {platform.release()}"
    if system == "Windows":
        ver = platform.version()
        return f"Windows {ver}"
    return platform.platform()


# ---------------------------------------------------------------------------
# YAML loading
# ---------------------------------------------------------------------------

def load_tests(tests_dir: Path) -> list[dict[str, Any]]:
    """Load all YAML test files and return a flat list of tests."""
    all_tests: list[dict[str, Any]] = []
    for yaml_file in sorted(tests_dir.glob("*.yaml")):
        with open(yaml_file, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if not data or "tests" not in data:
            continue
        category = data.get("category", yaml_file.stem)
        display_name = data.get("display_name", category)
        for test in data["tests"]:
            test["_category"] = category
            test["_display_name"] = display_name
            all_tests.append(test)
    return all_tests


def filter_tests(
    tests: list[dict[str, Any]],
    current_platform: str,
    category: str | None = None,
    test_id: str | None = None,
) -> list[dict[str, Any]]:
    """Filter tests by platform and optional category/ID."""
    result = []
    for t in tests:
        platforms = t.get("platforms", ["all"])
        if current_platform not in platforms and "all" not in platforms:
            continue
        if category and t["_category"] != category:
            continue
        if test_id and t["id"] != test_id:
            continue
        result.append(t)
    return result


# ---------------------------------------------------------------------------
# Infrastructure management
# ---------------------------------------------------------------------------

class Infrastructure:
    """Manages Docker containers, virtual serial ports, and the app process."""

    def __init__(self, skip_infra: bool, keep_infra: bool, app_path: str | None):
        self.skip_infra = skip_infra
        self.keep_infra = keep_infra
        self.app_path = app_path
        self.docker_started = False
        self.socat_proc: subprocess.Popen[bytes] | None = None
        self.app_proc: subprocess.Popen[bytes] | None = None
        self.config_dir: str | None = None

    def check_docker(self) -> bool:
        """Check if Docker is available and running."""
        if not shutil.which("docker"):
            return False
        try:
            subprocess.run(
                ["docker", "info"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False

    def check_serial(self) -> bool:
        """Check if socat is available for virtual serial ports."""
        return shutil.which("socat") is not None

    def check_app_binary(self, plat: str) -> str | None:
        """Find the app binary, return path or None."""
        if self.app_path:
            p = Path(self.app_path)
            return str(p) if p.exists() else None
        default = APP_PATHS.get(plat)
        if default and default.exists():
            return str(default)
        return None

    def start_docker(self) -> bool:
        """Start Docker test containers."""
        if self.skip_infra or self.docker_started:
            return self.docker_started
        if not DOCKER_COMPOSE.exists():
            print(f"  WARNING: {DOCKER_COMPOSE} not found")
            return False
        print("  Starting Docker test containers...")
        try:
            subprocess.run(
                ["docker", "compose", "-f", str(DOCKER_COMPOSE), "up", "-d", "--build"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.docker_started = True
            # Wait for key ports
            self._wait_for_port(2201, "SSH", timeout=30)
            return True
        except subprocess.CalledProcessError:
            print("  ERROR: Failed to start Docker containers")
            return False

    def start_serial(self) -> bool:
        """Start virtual serial ports via socat."""
        if self.socat_proc is not None:
            return True
        if not self.check_serial():
            return False
        pty_a = "/tmp/termihub-serial-a"
        pty_b = "/tmp/termihub-serial-b"
        for p in (pty_a, pty_b):
            if os.path.exists(p):
                os.remove(p)
        try:
            self.socat_proc = subprocess.Popen(
                ["socat", "-d", "-d",
                 f"pty,raw,echo=0,link={pty_a}",
                 f"pty,raw,echo=0,link={pty_b}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Wait for symlinks
            for _ in range(20):
                if os.path.exists(pty_a) and os.path.exists(pty_b):
                    return True
                time.sleep(0.5)
            print("  WARNING: Virtual serial ports did not appear")
            return False
        except FileNotFoundError:
            return False

    def generate_connections(self, tests: list[dict[str, Any]]) -> str:
        """Generate a connections.json in a temp dir from test setup actions."""
        connections: list[dict[str, Any]] = []
        seen_names: set[str] = set()

        for test in tests:
            for step in test.get("setup", []):
                if isinstance(step, dict) and "create_connection" in step:
                    conn_def = step["create_connection"]
                    name = conn_def["name"]
                    if name in seen_names:
                        continue
                    seen_names.add(name)
                    connections.append({
                        "type": "connection",
                        "name": name,
                        "config": {
                            "type": conn_def["type"],
                            "config": conn_def.get("config", {}),
                        },
                    })

        store = {
            "version": "2",
            "children": [
                {
                    "type": "folder",
                    "name": "Manual Test Connections",
                    "isExpanded": True,
                    "children": connections,
                }
            ] if connections else [],
            "agents": [],
        }

        config_dir = tempfile.mkdtemp(prefix="termihub-manual-test-")
        self.config_dir = config_dir
        config_file = os.path.join(config_dir, "connections.json")
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(store, f, indent=2)

        return config_dir

    def _wait_for_port(self, port: int, name: str, timeout: int = 30) -> bool:
        """Wait for a TCP port to become available."""
        for i in range(timeout):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    print(f"  {name} ready on port {port} ({i + 1}s)")
                    return True
            except (ConnectionRefusedError, socket.timeout, OSError):
                time.sleep(1)
        print(f"  WARNING: {name} on port {port} not ready after {timeout}s")
        return False

    def cleanup(self) -> None:
        """Tear down all managed infrastructure."""
        if self.socat_proc and self.socat_proc.poll() is None:
            self.socat_proc.terminate()
            try:
                self.socat_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.socat_proc.kill()
            for p in ("/tmp/termihub-serial-a", "/tmp/termihub-serial-b"):
                if os.path.exists(p):
                    os.remove(p)

        if self.app_proc and self.app_proc.poll() is None:
            self.app_proc.terminate()
            try:
                self.app_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.app_proc.kill()

        if self.docker_started and not self.keep_infra:
            print("  Stopping Docker containers...")
            subprocess.run(
                ["docker", "compose", "-f", str(DOCKER_COMPOSE), "down"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif self.keep_infra and self.docker_started:
            print("  Keeping Docker containers running (--keep-infra).")

        if self.config_dir and os.path.isdir(self.config_dir):
            shutil.rmtree(self.config_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Verification engine
# ---------------------------------------------------------------------------

def run_verification(verification: Any) -> list[dict[str, Any]]:
    """Run automated verification checks. Returns list of check results."""
    if verification == "manual" or verification is None:
        return []

    checks: list[dict[str, Any]] = []

    if isinstance(verification, dict):
        vtype = verification.get("type", "")

        if vtype == "file_exists":
            path = verification["path"]
            passed = os.path.isfile(path)
            checks.append({
                "description": verification.get("description", f"File {path} exists"),
                "passed": passed,
            })

        elif vtype == "json_check":
            path = verification["path"]
            jq_expr = verification.get("jq", "")
            desc = verification.get("description", f"JSON check: {jq_expr}")
            try:
                with open(path, encoding="utf-8") as f:
                    json.load(f)
                # Use jq if available, otherwise basic file validity
                if shutil.which("jq") and jq_expr:
                    result = subprocess.run(
                        ["jq", "-e", jq_expr, path],
                        capture_output=True,
                    )
                    checks.append({"description": desc, "passed": result.returncode == 0})
                else:
                    checks.append({"description": desc + " (jq not available — JSON valid)", "passed": True})
            except (json.JSONDecodeError, FileNotFoundError):
                checks.append({"description": desc, "passed": False})

        elif vtype == "process_running":
            name = verification["name"]
            desc = verification.get("description", f"Process '{name}' is running")
            try:
                if platform.system() == "Windows":
                    result = subprocess.run(
                        ["tasklist", "/FI", f"IMAGENAME eq {name}*"],
                        capture_output=True, text=True,
                    )
                    passed = name.lower() in result.stdout.lower()
                else:
                    result = subprocess.run(
                        ["pgrep", "-f", name],
                        capture_output=True,
                    )
                    passed = result.returncode == 0
                checks.append({"description": desc, "passed": passed})
            except FileNotFoundError:
                checks.append({"description": desc, "passed": False})

        elif vtype == "port_listening":
            port = int(verification["port"])
            desc = verification.get("description", f"Port {port} is listening")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=2):
                    checks.append({"description": desc, "passed": True})
            except (ConnectionRefusedError, socket.timeout, OSError):
                checks.append({"description": desc, "passed": False})

        elif vtype == "combined":
            for auto_check in verification.get("automated", []):
                checks.extend(run_verification(auto_check))

    return checks


# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------

def box_line(text: str, width: int = 66) -> str:
    """Format a line inside a box."""
    return f"  {text:<{width - 4}}"


def print_box(lines: list[str], width: int = 66) -> None:
    """Print a bordered box."""
    border = "+" + "-" * (width - 2) + "+"
    print(border)
    for line in lines:
        padded = line[:width - 4].ljust(width - 4)
        print(f"| {padded} |")
    print(border)


def print_test_card(
    test: dict[str, Any],
    index: int,
    total: int,
) -> None:
    """Print a test card for the user."""
    lines: list[str] = []
    tid = test["id"]
    name = test["name"]
    cat = test.get("_display_name", test.get("_category", ""))
    pr = test.get("pr")
    platforms = ", ".join(test.get("platforms", ["all"]))

    header = f"[{index}/{total}]  {tid}  {name}"
    lines.append(header)
    meta = f"Category: {cat}   Platform: {platforms}"
    if pr:
        meta += f"   PR: #{pr}"
    lines.append(meta)
    lines.append("")

    # Setup actions
    setup = test.get("setup", [])
    if setup:
        lines.append("SETUP:")
        for step in setup:
            if isinstance(step, dict):
                if "create_connection" in step:
                    conn = step["create_connection"]
                    lines.append(f"  [info] Pre-created connection: \"{conn['name']}\"")
                elif "connect" in step:
                    lines.append(f"  [action] Double-click \"{step['connect']}\" to connect")
                else:
                    lines.append(f"  [info] {step}")
            elif isinstance(step, str):
                lines.append(f"  [info] {step}")
        lines.append("")

    # Instructions
    lines.append("INSTRUCTIONS:")
    for i, instr in enumerate(test.get("instructions", []), 1):
        lines.append(f"  {i}. {instr}")
    lines.append("")

    # Expected
    lines.append("EXPECTED:")
    for exp in test.get("expected", []):
        lines.append(f"  - {exp}")
    lines.append("")

    # Verification hint
    verification = test.get("verification", "manual")
    if verification == "manual":
        lines.append("RESULT: [p]ass  [f]ail  [s]kip  [n]ote  [q]uit")
    elif isinstance(verification, dict):
        vtype = verification.get("type", "")
        if vtype == "combined":
            lines.append("Press Enter to run automated checks, then confirm.")
            lines.append("[p]ass  [f]ail  [s]kip  [n]ote  [q]uit")
        else:
            lines.append("Press Enter to run automated verification.")
            lines.append("[p]ass  [f]ail  [s]kip  [n]ote  [q]uit")

    print()
    print_box(lines)


def print_session_summary(
    plat: str,
    arch: str,
    os_version: str,
    tests: list[dict[str, Any]],
    all_count: int,
    infra: Infrastructure,
) -> None:
    """Print the session overview."""
    # Count by category
    categories: dict[str, int] = {}
    for t in tests:
        cat = t.get("_display_name", t.get("_category", "unknown"))
        categories[cat] = categories.get(cat, 0) + 1

    lines: list[str] = []
    lines.append("termiHub Guided Manual Tests")
    lines.append(f"Platform:  {os_version} ({arch})")
    lines.append(f"Date:      {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}")
    lines.append("")
    lines.append("Test categories for this platform:")
    for cat, count in categories.items():
        dots = "." * max(1, 30 - len(cat))
        lines.append(f"  {cat} {dots} {count:>3} tests")
    lines.append("")
    lines.append(f"Total applicable: {len(tests)} of {all_count} tests")
    lines.append("")
    lines.append("Infrastructure:")

    docker_ok = infra.check_docker()
    serial_ok = infra.check_serial()
    app_bin = infra.check_app_binary(plat)

    lines.append(f"  Docker ........... {'available' if docker_ok else 'not available'}")
    if plat != "windows":
        lines.append(f"  Virtual serial ... {'available (socat)' if serial_ok else 'not available'}")
    lines.append(f"  App binary ....... {'found' if app_bin else 'not found'}")

    print()
    print_box(lines)


def print_results_summary(results: list[dict[str, Any]], report_path: str, start_time: float) -> None:
    """Print the final session summary."""
    passed = sum(1 for r in results if r["status"] == "passed")
    failed = sum(1 for r in results if r["status"] == "failed")
    skipped = sum(1 for r in results if r["status"] == "skipped")
    not_run = sum(1 for r in results if r["status"] == "not_run")

    duration = int(time.time() - start_time)
    mins, secs = divmod(duration, 60)

    lines: list[str] = []
    lines.append("Session Complete")
    lines.append("")
    lines.append("Results:")
    lines.append(f"  Passed .............. {passed:>3}")
    lines.append(f"  Failed .............. {failed:>3}")
    lines.append(f"  Skipped ............. {skipped:>3}")
    lines.append(f"  Not run ............. {not_run:>3}")
    lines.append("")

    failed_tests = [r for r in results if r["status"] == "failed"]
    if failed_tests:
        lines.append("Failed tests:")
        for r in failed_tests:
            lines.append(f"  {r['id']}  {r['name']}")
            if r.get("note"):
                lines.append(f"    Note: \"{r['note']}\"")
        lines.append("")

    lines.append("Report saved to:")
    lines.append(f"  {report_path}")
    lines.append("")
    lines.append(f"Duration: {mins}m {secs:02d}s")

    print()
    print_box(lines)


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def build_report(
    results: list[dict[str, Any]],
    plat: str,
    arch: str,
    os_version: str,
    start_time: float,
) -> dict[str, Any]:
    """Build the JSON report object."""
    now = datetime.datetime.now(datetime.timezone.utc)
    started = datetime.datetime.fromtimestamp(start_time, tz=datetime.timezone.utc)

    passed = sum(1 for r in results if r["status"] == "passed")
    failed = sum(1 for r in results if r["status"] == "failed")
    skipped = sum(1 for r in results if r["status"] == "skipped")
    not_run = sum(1 for r in results if r["status"] == "not_run")

    return {
        "version": "1",
        "session": {
            "id": f"session-{started.strftime('%Y-%m-%dT%H%M%S')}",
            "started_at": started.isoformat(),
            "completed_at": now.isoformat(),
            "duration_seconds": int(now.timestamp() - start_time),
        },
        "environment": {
            "platform": plat,
            "arch": arch,
            "os_version": os_version,
            "docker_available": shutil.which("docker") is not None,
            "serial_available": shutil.which("socat") is not None,
        },
        "summary": {
            "total": len(results),
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
            "not_run": not_run,
        },
        "results": results,
    }


def save_report(report: dict[str, Any], report_dir: Path) -> str:
    """Write the JSON report and return the file path."""
    report_dir.mkdir(parents=True, exist_ok=True)
    plat = report["environment"]["platform"]
    arch = report["environment"]["arch"]
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%S")
    filename = f"manual-{ts}-{plat}-{arch}.json"
    path = report_dir / filename
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    return str(path)


# ---------------------------------------------------------------------------
# User input
# ---------------------------------------------------------------------------

def get_input(prompt: str = "> ") -> str:
    """Read a line from the user, handling Ctrl+C/Ctrl+D gracefully."""
    try:
        return input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        return "q"


def get_test_result(test: dict[str, Any]) -> tuple[str, str | None]:
    """Collect pass/fail/skip/note/quit from the user.

    Returns (status, note) where status is one of:
    'passed', 'failed', 'skipped', 'quit'.
    """
    note: str | None = None

    while True:
        verification = test.get("verification", "manual")
        has_auto = isinstance(verification, dict)

        choice = get_input("\n> ")

        if choice == "p":
            return ("passed", note)
        elif choice == "f":
            note_text = get_input("  Failure note (optional): ")
            if note_text:
                note = note_text
            return ("failed", note)
        elif choice == "s":
            return ("skipped", note)
        elif choice == "n":
            note_text = get_input("  Enter note: ")
            if note_text:
                note = note_text
                print(f"  Note recorded: \"{note}\"")
            continue
        elif choice == "q":
            return ("quit", note)
        elif choice == "" and has_auto:
            # Run automated verification
            checks = run_verification(verification)
            if checks:
                all_passed = all(c["passed"] for c in checks)
                print()
                print("  VERIFICATION:")
                for c in checks:
                    status_str = "pass" if c["passed"] else "FAIL"
                    print(f"    [{status_str}] {c['description']}")
                print()

                if all_passed:
                    print("  All checks passed. Press Enter to mark as pass, or [f]ail / [s]kip")
                    confirm = get_input("  > ")
                    if confirm in ("", "p"):
                        return ("passed", note)
                    elif confirm == "f":
                        note_text = get_input("  Failure note (optional): ")
                        if note_text:
                            note = note_text
                        return ("failed", note)
                    elif confirm == "s":
                        return ("skipped", note)
                    elif confirm == "q":
                        return ("quit", note)
                else:
                    print("  Some checks failed. [p]ass anyway / [f]ail / [s]kip")
                    confirm = get_input("  > ")
                    if confirm == "p":
                        return ("passed", note)
                    elif confirm in ("", "f"):
                        note_text = get_input("  Failure note (optional): ")
                        if note_text:
                            note = note_text
                        return ("failed", note)
                    elif confirm == "s":
                        return ("skipped", note)
                    elif confirm == "q":
                        return ("quit", note)
            else:
                # No automated checks available, treat as manual
                print("  No automated checks. [p]ass / [f]ail / [s]kip")
                continue

            # Also handle combined manual prompt
            if isinstance(verification, dict) and verification.get("type") == "combined":
                manual_prompt = verification.get("manual_prompt", "Manual check passed?")
                print(f"\n  {manual_prompt} [p]ass / [f]ail / [s]kip")
                confirm = get_input("  > ")
                if confirm in ("", "p"):
                    return ("passed", note)
                elif confirm == "f":
                    note_text = get_input("  Failure note (optional): ")
                    if note_text:
                        note = note_text
                    return ("failed", note)
                elif confirm == "s":
                    return ("skipped", note)
                elif confirm == "q":
                    return ("quit", note)
        elif choice == "":
            # Enter with no auto verification — prompt again
            print("  [p]ass  [f]ail  [s]kip  [n]ote  [q]uit")
            continue
        else:
            print("  Unknown input. [p]ass  [f]ail  [s]kip  [n]ote  [q]uit")
            continue

    # Should not reach here
    return ("skipped", note)


# ---------------------------------------------------------------------------
# Resume support
# ---------------------------------------------------------------------------

def load_resume(resume_path: str) -> set[str]:
    """Load completed test IDs from a previous report."""
    with open(resume_path, encoding="utf-8") as f:
        report = json.load(f)
    completed: set[str] = set()
    for r in report.get("results", []):
        if r.get("status") in ("passed", "failed", "skipped"):
            completed.add(r["id"])
    return completed


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="termiHub Guided Manual Test Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--category", help="Run only tests in a specific category")
    parser.add_argument("--test", help="Run a single test by ID (e.g., MT-LOCAL-03)")
    parser.add_argument("--platform", help="Override platform detection (macos, linux, windows)")
    parser.add_argument("--skip-setup", action="store_true", help="Skip infrastructure setup")
    parser.add_argument("--skip-infra", action="store_true", help="Skip Docker container management")
    parser.add_argument("--keep-infra", action="store_true", help="Keep Docker containers running after session")
    parser.add_argument("--app-path", help="Path to app binary (overrides auto-detection)")
    parser.add_argument("--report-dir", help="Output directory for reports")
    parser.add_argument("--resume", help="Resume a previous session from a report file")
    parser.add_argument("--list", action="store_true", help="List all tests for the current platform (no run)")

    args = parser.parse_args()

    # Platform
    plat = args.platform or detect_platform()
    arch = detect_arch()
    os_version = detect_os_version()

    # Report dir
    report_dir = Path(args.report_dir) if args.report_dir else DEFAULT_REPORT_DIR

    # Load tests
    if not TESTS_DIR.is_dir():
        print(f"ERROR: Test definitions not found at {TESTS_DIR}")
        return 1

    all_tests = load_tests(TESTS_DIR)
    if not all_tests:
        print("ERROR: No test definitions found")
        return 1

    filtered = filter_tests(all_tests, plat, args.category, args.test)
    if not filtered:
        print(f"No tests match platform='{plat}'", end="")
        if args.category:
            print(f", category='{args.category}'", end="")
        if args.test:
            print(f", test='{args.test}'", end="")
        print()
        return 1

    # List mode
    if args.list:
        print(f"\nManual tests for {plat} ({len(filtered)} of {len(all_tests)}):\n")
        current_cat = ""
        for t in filtered:
            cat = t.get("_display_name", "")
            if cat != current_cat:
                current_cat = cat
                print(f"\n  {cat}")
                print(f"  {'=' * len(cat)}")
            pr_ref = f"  (PR #{t['pr']})" if t.get("pr") else ""
            print(f"    {t['id']:15s} {t['name']}{pr_ref}")
        print()
        return 0

    # Resume support
    completed_ids: set[str] = set()
    if args.resume:
        try:
            completed_ids = load_resume(args.resume)
            print(f"Resuming session: {len(completed_ids)} tests already completed")
        except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
            print(f"WARNING: Could not load resume file: {e}")

    # Infrastructure
    infra = Infrastructure(
        skip_infra=args.skip_infra or args.skip_setup,
        keep_infra=args.keep_infra,
        app_path=args.app_path,
    )
    atexit.register(infra.cleanup)

    # Session summary
    print_session_summary(plat, arch, os_version, filtered, len(all_tests), infra)

    print("\nPress Enter to begin, or 'q' to quit.")
    choice = get_input()
    if choice == "q":
        return 0

    # Generate connections config if not skipping setup
    if not args.skip_setup:
        config_dir = infra.generate_connections(filtered)
        print(f"\n  Test connections written to: {config_dir}/connections.json")
        print(f"  Launch the app with: TERMIHUB_CONFIG_DIR=\"{config_dir}\" pnpm tauri dev")
        if plat == "windows":
            print(f"  (Windows): set TERMIHUB_CONFIG_DIR={config_dir} && pnpm tauri dev")

    # Main test loop
    start_time = time.time()
    results: list[dict[str, Any]] = []
    total = len(filtered)
    quit_requested = False

    for i, test in enumerate(filtered, 1):
        if test["id"] in completed_ids:
            # Already completed in resumed session
            results.append({
                "id": test["id"],
                "name": test["name"],
                "category": test["_category"],
                "status": "skipped",
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "duration_seconds": 0,
                "note": "Skipped (completed in previous session)",
                "verification_type": "resumed",
            })
            continue

        # Check prerequisites and start infra lazily
        prereqs = test.get("prerequisites", [])
        for prereq in prereqs:
            if isinstance(prereq, dict):
                if prereq.get("docker") and not infra.skip_infra:
                    if not infra.docker_started:
                        infra.start_docker()
                if prereq.get("serial"):
                    infra.start_serial()

        # Present the test
        test_start = time.time()
        print_test_card(test, i, total)

        # Collect result
        status, note = get_test_result(test)

        if status == "quit":
            # Record remaining as not_run
            results.append({
                "id": test["id"],
                "name": test["name"],
                "category": test["_category"],
                "status": "not_run",
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "duration_seconds": int(time.time() - test_start),
                "note": note,
                "verification_type": str(test.get("verification", "manual")),
            })
            quit_requested = True
            break

        verification = test.get("verification", "manual")
        vtype = "manual"
        if isinstance(verification, dict):
            vtype = verification.get("type", "automated")

        results.append({
            "id": test["id"],
            "name": test["name"],
            "category": test["_category"],
            "status": status,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "duration_seconds": int(time.time() - test_start),
            "note": note,
            "verification_type": vtype,
        })

        # Save progress after each test
        partial_report = build_report(results, plat, arch, os_version, start_time)
        save_report(partial_report, report_dir)

    # Mark remaining tests as not_run if quit early
    if quit_requested:
        remaining_idx = next(
            (j for j, t in enumerate(filtered) if t["id"] not in {r["id"] for r in results}),
            len(filtered),
        )
        for t in filtered[remaining_idx:]:
            if t["id"] not in {r["id"] for r in results}:
                results.append({
                    "id": t["id"],
                    "name": t["name"],
                    "category": t["_category"],
                    "status": "not_run",
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "duration_seconds": 0,
                    "note": None,
                    "verification_type": str(t.get("verification", "manual")),
                })

    # Final report
    report = build_report(results, plat, arch, os_version, start_time)
    report_path = save_report(report, report_dir)

    # Summary
    print_results_summary(results, report_path, start_time)

    # Return non-zero if any tests failed
    failed_count = sum(1 for r in results if r["status"] == "failed")
    return 1 if failed_count > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
