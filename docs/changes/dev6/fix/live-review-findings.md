### Fixed

- HTTP monitors: a failed check says why, such as "Connection refused: nothing is listening on
  127.0.0.1:8080" or "No answer from example.com:443 within 5 s", instead of "error sending
  request for url".
- HTTP monitors: like a Services row, a monitor's row names the machine it runs on only when that
  is an agent.
- Automations: the Save recording dialog always shows "Add to an automation", turned off with
  "No automations yet" while there is none, and "Keep for later" says where the recording waits.
- Automations: the import dialog has a button that opens the setting an imported local program
  still waits for.
