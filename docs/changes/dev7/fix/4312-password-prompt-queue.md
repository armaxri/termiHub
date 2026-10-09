### Fixed

- Password prompts: when several connections ask for a password at once (a workspace
  opening several SSH tabs, a jump host plus its target, two connects started together),
  the prompts now wait their turn and appear one after another, each titled with the
  connection it is for. Previously the second prompt replaced the first, and the first
  connect hung forever. Cancelling one prompt only cancels that connect, the "Save
  password" choice applies to its own prompt, and closing a tab drops its pending
  prompt (#4312).
