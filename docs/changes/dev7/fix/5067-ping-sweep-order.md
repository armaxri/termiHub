### Fixed

- Network Tools: Ping Sweep results are now listed in numeric address order
  (`192.168.0.9` before `192.168.0.10` before `192.168.0.100`; IPv6 by value) and stay
  sorted while the sweep runs. A new **Order** control switches to response order (the
  order hosts answered); the choice is remembered. The Port Scanner uses the same control
  (address order lists hosts numerically, then ports ascending), and recorded history
  tables keep address order (#5067).
