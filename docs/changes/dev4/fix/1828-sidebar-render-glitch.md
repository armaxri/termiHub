### Fixed

- The Connections sidebar no longer renders clipped or partially laid out on
  launch. When the Remote Agents sections mounted (after settings and agents
  loaded asynchronously), the section flex-sizing hook briefly returned fewer
  flex values than there were sections, so a section laid out size-to-content
  instead of filling its slot. On WebKit that mis-sized first paint stuck until
  a manual tab/window resize forced a reflow. The sidebar now stays correctly
  sized on the first paint with no resize needed (#1828).
