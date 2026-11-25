### Security

- **Continue of an automation that waits for you could go on although a password prompt had just
  arrived**, and type the next keys into it. Output that does not show yet now counts; when that cannot
  be told within a second, or another window controls the terminal, Continue asks instead. "Continue
  anyway" counts for the prompt it was said of, not for the next one. (#6070)
- **A recording could store a password** that was typed before its prompt showed on the screen. What
  cannot be judged is now kept apart, and you decide when saving. (#6070)

### Fixed

- A Wait step of an automation longer than 5 s was silently cut. It lasts as long as it says, up to an
  hour, and Stop ends it at once. (#6008)
