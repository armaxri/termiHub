### Fixed

- Embedded servers, Wake-on-LAN devices and HTTP monitors are now downgrade-safe
  (#3946). A file written by a newer termiHub is never overwritten by an older one
  after a rollback: it is left intact, a startup notice explains why, and every save
  over it is refused. A corrupt file is backed up to `.json.bak` and only the broken
  entries are dropped — previously an unreadable Wake-on-LAN or HTTP monitor file
  was silently replaced on the next save, losing every saved entry. An embedded
  servers file without a `version` field loads as before instead of being reset, and
  settings a newer build added at the top level of these files survive a save.
