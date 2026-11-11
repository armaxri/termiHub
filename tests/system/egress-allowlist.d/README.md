# Egress allowlist (#5388)

Tests whose app under test legitimately reaches a destination outside the
harness's fixtures. The system-test egress probe (`termihub_harness/egress.py`,
`TERMIHUB_EGRESS_GATE`) reports every other non-fixture connection. Loopback,
private, link-local and carrier-grade-NAT addresses are fixtures already and
need no entry. Each `*.json` file is one entry, tied to the issue that owns it:

```json
{
  "nodeid": "test_plugin_discovery_https\\.py",
  "remote": "^140\\.82\\.",
  "issue": 4961,
  "reason": "grades plugin discovery against the real GitHub index"
}
```

- `nodeid` (optional): a regex searched in the test's node id.
- `remote` (optional): a regex searched in the destination `ip:port`
  (`[ip]:port` for IPv6).
- At least one of `nodeid` and `remote` is required.
- `issue` (required): the issue that tracks the test or the destination.
- `reason` (required): why the test needs the destination.

`TERMIHUB_EGRESS_ALLOW` adds comma-separated CIDRs or `ip:port` entries for a
local run (a corporate proxy, say). Name the file `<issue>-<slug>.json`.
See docs/testing.md, "Egress probe".
