### Added

- Guided Git for Windows install: on Windows, when no Unix shell is detected
  (no Git Bash, no WSL bash), the _Settings → General → Default Shell_ picker now
  shows a **"Git Bash — set up…"** entry that opens a consent-gated dialog. From
  there you can install Git for Windows in a pre-loaded terminal tab
  (`winget install --id Git.Git -e`) or open the official git-scm.com download
  page for machines without winget. Once the install finishes, Git Bash is
  re-detected and offered automatically — no app restart. Builds on the hardened
  Git Bash detection (#1671) and reuses the existing guided-install primitive
  (#1672).
