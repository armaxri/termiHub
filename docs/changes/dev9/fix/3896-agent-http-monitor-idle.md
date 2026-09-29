### Fixed

- An HTTP monitor running on a remote agent no longer keeps checking its URL
  after the desktop disconnects. Before, the agent sent a request every interval
  with nobody receiving the results. The monitor now idles while no desktop is
  attached and keeps its last result. When a desktop attaches again, it checks
  again within one interval.
