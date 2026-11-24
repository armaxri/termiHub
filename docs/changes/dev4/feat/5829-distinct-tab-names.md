### Changed

- New terminal tabs are named after their shell instead of all reading
  "Terminal": a second zsh tab reads "zsh 2", a third "zsh 3". The "Closed …"
  toast names the tab you closed the same way. A tab you renamed keeps its name.
- A new shell on a remote agent reads "<agent> · bash" instead of
  "Shell: /bin/bash", in the tab and in the agent's session list, so shells on
  two agents can be told apart. Sessions on an agent are no longer called
  "local session".
