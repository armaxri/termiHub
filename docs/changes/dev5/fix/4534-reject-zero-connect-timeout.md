### Changed

- Plugins: manifest validation now enforces ranges on `connectionPolicy`.
  `connectTimeoutMs` must be 1 to 600000 (ten minutes) and `maxConnections`
  1 to 256. A `0` timeout used to validate and then made every connection
  fail; it is now refused at install with an error naming the field, the
  value and the allowed range. An already-installed plugin with an
  out-of-range value is refused at load the same way (#4534).
