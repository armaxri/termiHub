"""Stage the deployed-agent binary into its Docker build context (#4479).

A command-line entry point for :func:`~termihub_harness.fixtures.stage_remote_agent_binary`,
so the nightly system-integration workflow can stage the static-musl test-hooks
agent into ``tests/docker/remote-agent/termihub-agent`` and pre-build the
``agent``-profile images in its fixture step, before the test step.

Without it those images could only be built by the harness, inside a test, under
the 300 s compose bring-up timeout (which fails the suite in CI strict mode). It
calls the harness function itself rather than copying its steps, so the
workflow and the harness cannot drift on where the binary is built, how it is
checked for the test key, or where it is staged (#3664). The harness still
stages and builds with ``build=True`` on its own; once this has run, cargo and
Docker's layer cache make that a no-op.

Usage (from ``tests/system``)::

    uv run --frozen python -m termihub_harness.stage_agent [--build-timeout SECONDS]

Prints the staged path as its last line. Exit 0 = staged; 1 = it could not be
staged (no Linux container runtime, or the build failed); 2 = bad arguments.
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional, Sequence

from . import fixtures


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m termihub_harness.stage_agent",
        description=(
            "Build (if needed) the static-musl test-hooks agent and stage it into "
            "tests/docker/remote-agent/ so the agent-profile images can be built."
        ),
    )
    parser.add_argument(
        "--build-timeout",
        type=float,
        default=1500.0,
        metavar="SECONDS",
        help="ceiling for the agent build (default: %(default)s, the harness' own)",
    )
    args = parser.parse_args(argv)
    if args.build_timeout <= 0:
        parser.error("--build-timeout must be positive")

    try:
        staged = fixtures.stage_remote_agent_binary(build_timeout=args.build_timeout)
    except (fixtures.ContainerRuntimeUnavailable, fixtures.ComposeFixtureFailed) as exc:
        # Both mean "not staged": exiting non-zero is the point, a skip here
        # would let the images build cold inside a test again.
        print(f"ERROR: could not stage the deployed-agent binary: {exc}", file=sys.stderr)
        return 1
    print(staged)
    return 0


if __name__ == "__main__":
    sys.exit(main())
