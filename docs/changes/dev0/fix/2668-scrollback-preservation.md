### Fixed

- Terminal output no longer yanks the viewport to the bottom when you have
  scrolled up to read earlier output. The auto-scroll guard now reads the
  terminal's live scroll position at the moment output arrives, instead of a
  cached scroll-event flag that could go stale (e.g. right after a wheel or
  programmatic scroll) or transiently report "at bottom" mid-render on WebKit —
  either of which snapped the view back down on new output (#2682).
