"""A tiny local server for the product run's progress page (#5518).

``python -m termihub_harness.product_run.server --run-dir <run>`` serves the run
directory on ``127.0.0.1`` only (a free port, written to ``<run>/server.url``)
and accepts one write: ``POST /api/human`` with ``{"token", "result", "note"}``,
the page's answer to the human step that is open right now. It writes
``<run>/human/<token>.json``, which the waiting runner picks up. A token that is
not the open prompt's is refused, so a stale page cannot answer a later step.

The page also works opened as a file (it polls ``status.js``); then the Done
button is replaced by the one-line ``echo`` that writes the same answer file.

Standard library only.
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

RESULTS = ("done", "failed", "skip")
_MAX_BODY = 16 * 1024


def answer_human(run_dir: Path, body: dict) -> tuple[int, str]:
    """Validate a page answer and write it; returns ``(http status, message)``."""
    token = str(body.get("token", ""))
    result = str(body.get("result", ""))
    note = str(body.get("note", ""))[:2000]
    if result not in RESULTS:
        return HTTPStatus.BAD_REQUEST, f"result must be one of {', '.join(RESULTS)}"
    try:
        status = json.loads((run_dir / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return HTTPStatus.CONFLICT, "the run has no status yet"
    open_prompt = status.get("human") or {}
    if not token or token != open_prompt.get("token"):
        return HTTPStatus.CONFLICT, "that prompt is no longer open"
    human_dir = run_dir / "human"
    human_dir.mkdir(exist_ok=True)
    tmp = human_dir / f".{token}.tmp"
    tmp.write_text(json.dumps({"result": result, "note": note}) + "\n", encoding="utf-8")
    os.replace(tmp, human_dir / f"{token}.json")
    return HTTPStatus.OK, "recorded"


class _Handler(SimpleHTTPRequestHandler):
    run_dir: Path

    def __init__(self, *args, run_dir: Path, **kwargs) -> None:
        self.run_dir = run_dir
        super().__init__(*args, directory=str(run_dir), **kwargs)

    def end_headers(self) -> None:  # the page polls; never serve a cached status
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        if self.path != "/api/human":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > _MAX_BODY:
            self.send_error(HTTPStatus.BAD_REQUEST, "missing or oversized body")
            return
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "body is not JSON")
            return
        code, message = answer_human(self.run_dir, body if isinstance(body, dict) else {})
        payload = json.dumps({"ok": code == HTTPStatus.OK, "message": message}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - quiet polls
        return


def make_server(run_dir: Path, port: int = 0) -> ThreadingHTTPServer:
    """A server bound to loopback for ``run_dir`` (``port=0`` picks a free one)."""
    handler = functools.partial(_Handler, run_dir=run_dir)
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)
    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    server = make_server(run_dir, args.port)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    (run_dir / "server.url").write_text(url + "\n", encoding="utf-8")
    print(f"product-run page: {url}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
