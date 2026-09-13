### Changed

- The remaining hand-rolled search/filter fields now use the shared `SearchInput`
  primitive, so they match the rest of the app: a leading search icon and a clear
  (×) button that appears while the field has text. This covers the connection
  and remote-agent filters, the file-browser filter, the Log Viewer search, and
  the status-bar language picker (the last two gain a clear button they did not
  have before). Filtering behavior and results are unchanged (UISF-004, #2928).
