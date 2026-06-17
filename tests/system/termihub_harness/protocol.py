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
from typing import Any, Optional


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
