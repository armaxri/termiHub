### Fixed

- On macOS and Linux, clicks in the app no longer log a refused clipboard write
  (`NotAllowedError`) followed by an unhandled `Canceled` rejection. The file
  editor's WebKit clipboard workaround now handles a refused write quietly, and
  a copy after such a refusal uses the normal clipboard path instead of being
  lost (#5383).
