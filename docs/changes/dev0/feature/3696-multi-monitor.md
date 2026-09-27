### Added

- RDP and VNC sessions can span multiple monitors (#3696). The connection
  editor's **Display** group gains **Monitors**: _Single_ (the default, so
  existing connections are unchanged), _All local displays_ (one remote monitor
  per display of this computer) or _Custom count_ (2–16 side-by-side monitors
  the size of your primary display).
  - The session renders in one tab as the combined desktop. A new toolbar
    button cycles the view between all monitors and each single monitor.
  - RDP sends the monitor layout at connect and whenever it changes; an _All
    local displays_ session follows your displays when the window regains
    focus after a display was added or removed.
  - VNC asks the server for one screen per monitor where the server supports
    it (RFB ExtendedDesktopSize) and otherwise keeps the server's own layout. A
    VNC server that already has several screens gets per-monitor views too.
  - A multi-monitor session keeps its layout size instead of following the tab.
