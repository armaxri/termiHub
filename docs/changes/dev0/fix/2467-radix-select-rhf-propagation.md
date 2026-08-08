### Fixed

- The connection editor's **Save** / **Save & Connect** could stay disabled for
  a fully valid connection. When you switched the connection **Type**, every
  field is reset to `null` so a shared-name field cannot leak the previous
  type's value (#1820) — but the client-side form validator (zod) treated a
  `null` optional field as invalid input. Any optional field left at its default
  (e.g. an SSH connection's Advanced *Shell* or *Connect timeout*) then reported
  a spurious "Invalid input", so the form never became valid and both save
  buttons remained greyed out. Optional fields now accept `null` as "empty", so
  a connection with untouched optional fields validates and saves as expected
  (#2467).
