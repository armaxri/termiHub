### Fixed

- Host key and certificate fingerprints in the trust dialog now sit on a row of
  their own, never break mid-string (only after the `SHA256:` prefix or a `:`
  between hex bytes) and keep a clear gap before the copy button (#5662).
- After you reject a host key, the screen says so once: the heading and one line
  on what to do next, instead of a red error box and a paragraph repeating it
  (#5662).
