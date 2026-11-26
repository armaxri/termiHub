### Security

- A saved connection that was changed elsewhere (a restored backup, an import, or a connection file
  another machine syncs) no longer runs anything by itself on this machine: the last session and a
  workspace hold its tab and show where it connects and what it would run, a schedule skips it, and
  opening it by hand asks first when it starts a program, types a command or forwards your agent or
  display. Connections this machine already had keep working, and saving one in the editor confirms
  it. (#6065)
