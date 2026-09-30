### Fixed

- Agent: a corrupt `connections.json` on the remote agent is no longer silently wiped. The agent backs it up to `connections.json.corrupt-<timestamp>`, logs where the copy went, and keeps every saved connection and folder that still parses. Fields the agent does not recognise are now kept across saves instead of being dropped (#3931).
