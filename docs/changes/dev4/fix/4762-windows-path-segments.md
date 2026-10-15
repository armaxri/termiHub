### Security

- Plugin `filesystemPaths`: a Windows-form entry whose folder names Windows
  would rewrite or treat specially now fails manifest validation on every OS.
  Before, `C:\data\.. \tools` passed and was shown verbatim at install, but
  Windows resolved it to `C:\tools`, so the folder granted differed from the
  one approved. Names ending in `.` or a space, a `:` after the drive
  (alternate data stream), the characters `<>"|?*` and reserved device names
  such as `CON` or `nul.txt` are refused, both in plain Windows paths and after
  `${home}`/`${config}`.
