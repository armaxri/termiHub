### Fixed

- Connection editor: a tab opened with **Save & Connect** is now bound to its saved
  connection, like a connect from the sidebar. Schedules targeting the connection now run
  on that tab instead of reporting "None of the target connections is connected" (#5257).
  A file transfer started on that session can also be resumed after an app restart
  (#5258).
- Connection editor: a password or key passphrase typed into the prompt that **Save &
  Connect** opens is now saved only once the connection succeeds, like a sidebar connect
  (#5156). A mistyped secret the server rejects is no longer stored. A password typed into
  the editor's own Password field is still saved on Save, as before.
