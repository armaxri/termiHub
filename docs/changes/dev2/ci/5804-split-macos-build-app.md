### Internal

- Release builds: the Windows and Linux desktop builds no longer wait for the macOS helpers to be
  built and signed, and a macOS signing problem no longer skips them. The macOS desktop build runs
  as its own job, `build-app-macos`
  ([#5804](https://github.com/armaxri/termiHub/issues/5804)).
