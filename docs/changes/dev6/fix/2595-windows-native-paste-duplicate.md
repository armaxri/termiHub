### Fixed

- A single right-click paste in the terminal no longer inserts the clipboard
  twice on Windows (and over Remote Desktop). Two paste routes fired for one
  gesture: termiHub's own right-click quick action (already debounced) and a
  native `paste` event that WebView2/RDP injects into xterm's focused helper
  `<textarea>`, which xterm re-emitted as terminal input — bypassing termiHub's
  paste guards entirely. xterm's native textarea paste is now suppressed at the
  source, so the only paste route is termiHub's own handler; Ctrl+V, the
  right-click quick action, and the context-menu Paste item each insert exactly
  once (#2595).
