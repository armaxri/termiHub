### Fixed

- The ping latency graph now scales its y-axis to the data, so a sub-millisecond
  LAN series fills the chart instead of drawing as a flat line along the bottom.
  Axis labels show fractional values cleanly (e.g. "0.2ms"), and the axis no
  longer jumps back and forth while latency jitters around a boundary (#4734).
