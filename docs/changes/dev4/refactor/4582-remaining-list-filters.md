### Changed

- Search in the plugin catalog, the status-bar language picker, the Docker
  container and Compose service pickers, the file browser name filter and the
  embedded-server activity log now ignores accents, like the sidebar search
  (`muller` finds `Müller`). The container ID still matches by prefix. The log
  viewer and open-ports filters intentionally keep exact substring matching.
