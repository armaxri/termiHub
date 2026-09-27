"""Wire protocol for the cross-platform test bridge (issue #801).

The runner hosts a WebSocket server; the app connects out to it and runs each
command in-process. Because several commands may be in flight at once, every
message is wrapped in an envelope carrying a monotonic ``id`` so a response can
be matched back to its request:

    runner -> app : {"id": <int>, "command": {"action": ..., ...}}
    app -> runner : {"id": <int>, "response": {"ok": <bool>, "action": ..., ...}}

This mirrors ``src/testbridge/wsProtocol.ts`` exactly; the two implementations
are kept in parity as the command vocabulary evolves.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional
from urllib.parse import parse_qs, urlsplit


# A command is a plain dict with at least an "action" key, matching the
# TypeScript BridgeCommand union. The Driver builds these; see driver verbs.
Command = dict[str, Any]
Response = dict[str, Any]


def encode_request(request_id: int, command: Command) -> str:
    """Serialize a ``{id, command}`` request envelope to a JSON string."""
    return json.dumps({"id": request_id, "command": command})


def decode_response(data: str) -> Optional[tuple[int, Response]]:
    """Parse a ``{id, response}`` envelope.

    Returns ``(id, response)`` or ``None`` when the frame is not a well-formed
    response envelope (non-JSON, missing fields, wrong types) — mirroring the
    permissive ``isResponseEnvelope`` narrowing on the TypeScript side.
    """
    try:
        parsed = json.loads(data)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    request_id = parsed.get("id")
    response = parsed.get("response")
    if not isinstance(request_id, int) or isinstance(request_id, bool):
        return None
    if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
        return None
    return request_id, response


# ── Multi-window routing (TIN-014, #3720) ────────────────────────────────────
#
# Each native window of the app is its own page with its own in-app bridge, so
# each dials its own socket. The window names itself in the connection URL
# (``ws://127.0.0.1:<port>/?window=<label>``), read by the runner at the
# handshake. An untagged connection (an older app build) is the main window, so
# single-window suites are unaffected. Mirrors ``bridgeWindowFromRequestPath`` in
# ``src/testbridge/wsProtocol.ts``.

#: The window a connection without a ``window`` parameter belongs to.
MAIN_WINDOW = "main"

#: Query parameter carrying the connecting window's runtime label.
WINDOW_QUERY_PARAM = "window"

#: Tauri's label alphabet (alphanumerics plus ``-``, ``/``, ``:``, ``_``), capped.
_WINDOW_LABEL = re.compile(r"^[A-Za-z0-9_:/-]{1,128}$")


def is_valid_window_label(label: str) -> bool:
    """Whether ``label`` is an acceptable bridge window label."""
    return bool(_WINDOW_LABEL.match(label))


def window_from_request_path(path: Optional[str]) -> Optional[str]:
    """The window label a connection belongs to, from its request path.

    Returns :data:`MAIN_WINDOW` when the ``window`` parameter is absent (a legacy
    single-window client) and ``None`` when it is present but malformed — the
    runner then refuses the connection rather than mistaking it for the main
    window.
    """
    query = urlsplit(path or "").query
    values = parse_qs(query, keep_blank_values=True).get(WINDOW_QUERY_PARAM)
    if values is None:
        return MAIN_WINDOW
    label = values[0]
    return label if is_valid_window_label(label) else None
