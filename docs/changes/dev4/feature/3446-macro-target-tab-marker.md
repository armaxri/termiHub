### Added

- While a macro plays into several terminals at once, every receiving tab is now
  marked in the tab strip with a violet "receiving macro" badge (distinct from the
  orange broadcast badge), in every split panel. Its tooltip and screen-reader
  label read `Receiving macro "<name>" (n/m steps)`. A tab loses the badge as soon
  as it stops receiving — disconnected, taken over, or its input failed — and all
  badges clear when the run finishes or is cancelled. Single-terminal playback is
  unchanged. (#3446)
