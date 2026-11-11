# JS error allowlist (#5364)

Known JavaScript errors in the app under test that the system-test JS error gate
(`termihub_harness/js_errors.py`, `TERMIHUB_JS_ERROR_GATE`) tolerates. Each
`*.json` file is one entry, tied to the issue that tracks fixing the error:

```json
{
  "pattern": "^unhandledrejection: Canceled$",
  "issue": 1234,
  "reason": "xterm addon disposal rejects with Canceled on tab close",
  "nodeid": "test_ssh_jump_host\\.py"
}
```

- `pattern` (required): a regex searched in the error key
  `<kind>: <first message line>`, where kind is `unhandledrejection`, `error`
  or `console.error`.
- `issue` (required): the open issue that tracks the error.
- `reason` (required): why it is tolerated for now.
- `nodeid` (optional): a regex that limits the entry to matching tests.

Name the file `<issue>-<slug>.json`, and delete it in the PR that fixes the issue.
See docs/testing.md, "JS error gate".
