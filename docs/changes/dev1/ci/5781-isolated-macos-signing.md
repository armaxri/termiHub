### Security

- macOS release builds are now signed in dedicated jobs that run no third-party build code: the
  project's macOS signing identity no longer shares a build machine with dependency or compiler
  code, so a compromised dependency can neither export it nor sign anything else with it
  ([#5781](https://github.com/armaxri/termiHub/issues/5781)).
