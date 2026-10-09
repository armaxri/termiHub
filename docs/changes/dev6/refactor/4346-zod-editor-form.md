### Fixed

- Editors: when Save is disabled, the macro, workflow, embedded-server, tunnel and
  highlight-rule editors now show why. Missing names, root directories and ports, and
  invalid highlight colours, get an inline message under the field (#4346).
- Connection editor: clearing a required field now shows "<Field> is required"
  instead of "Invalid input: expected string, received undefined" (#4346).
