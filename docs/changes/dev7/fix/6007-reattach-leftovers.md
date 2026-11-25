### Fixed

- A terminal whose session another window took over and gave back no longer shows its last output twice when an inline image, a burst of output or a plugin's protocol parser had delayed it (#6003).
- Attaching to a persistent session while its previous connection is still being cleaned up no longer leaves the tab without its session, log or tab binding (#6004).
- Reconnecting to an agent that came back as a new process no longer shows a session's history twice, keys typed until a resumed tab is ready reach the session, and the "resumed" line carries the time it was written (#6007).
