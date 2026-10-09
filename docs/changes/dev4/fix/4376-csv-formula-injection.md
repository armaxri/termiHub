### Security

- Network-tool CSV exports (ping, traceroute, port scan, DNS lookup, open ports,
  HTTP monitor history and recorded runs) now neutralise spreadsheet formulas: a
  text cell starting with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`, so a
  hostile DNS TXT record or PTR name can no longer run as a formula when the file
  is opened in Excel, LibreOffice or Sheets. Numeric cells, including negative
  values, stay numeric (#4376).
