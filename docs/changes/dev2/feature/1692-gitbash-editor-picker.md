### Added

- Guided Git for Windows install in the Connection Editor: when you configure a
  **local** connection on Windows and no Unix shell is detected (no Git Bash, no
  WSL bash), the shell picker now shows a **"Git Bash — set up…"** entry point
  that opens the same consent-gated dialog as the _Settings → General → Default
  Shell_ picker (#1672). Install Git for Windows in a pre-loaded terminal tab or
  open git-scm.com; once it finishes, Git Bash is re-detected and becomes
  selectable in the picker without reopening the editor.
