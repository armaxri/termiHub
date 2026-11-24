### Fixed

- Closing several tabs in a row no longer stacks one identical "Closed “Terminal” · Reopen"
  toast per tab over the editor (#5828). Closes within a few seconds of each other now share
  one toast that updates in place: a single close still names the tab ("Closed “web”" ·
  Reopen), several read "Closed 3 tabs" with the tab names listed and a "Reopen all" that
  restores every closed tab in the order it was closed.
