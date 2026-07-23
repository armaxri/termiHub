# Changes

## Fixed

- **SSH connection editor**: the Advanced → Shell field on a new SSH connection no
  longer auto-fills the local host's default shell (`powershell` on Windows) and can
  now be left empty or cleared. Switching the connection type used to leak the previous
  type's value for any field with a shared name — the schema-driven form kept
  react-hook-form's cached value for the `shell` field — so a new SSH connection
  inherited the local shell and could not clear it. The form now explicitly clears
  every field of the newly selected type, so a field the new type does not default
  (like the SSH remote shell) starts empty and stays empty when cleared.
