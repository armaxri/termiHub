### Changed

- Numeric form fields (SSH tunnel ports, jump-host port and connect timeout,
  and schema-driven connection number/port fields) now share the same
  blank-value behavior: clearing a numeric field leaves it blank and flags it
  as required/invalid — blocking Save — instead of silently snapping back to a
  default (previously `0` for tunnel ports, `22` for a jump-host port). Valid
  values still save exactly as before (#1444).
