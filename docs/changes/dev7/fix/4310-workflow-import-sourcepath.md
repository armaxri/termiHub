### Security

- An imported workflow can no longer make a "run script" step read a hidden
  local file (for example an SSH key or cloud credentials) and type it into a
  remote shell. When you import workflows, any local script file a step
  references is removed and listed in the import notice as untrusted. The step
  keeps only the script you can see in the editor.
- A "run script" step that loads its script from a local file now reads that
  file only if you picked or confirmed it on this machine. The step editor
  shows the file's real path, warns when it has not been confirmed, and offers
  **Confirm file**, **Choose another file…** and **Detach file**. You can also
  load a script with **Load from file…**. Editing the script text detaches the
  file, so what you see is what runs.

### Fixed

- A "run script" step whose script file cannot be read now fails with a clear
  error naming the file. Before, it silently ran an old embedded copy of the
  script instead.
