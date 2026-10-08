### Fixed

- Out-of-process plugins (preview) can now list a directory whose listing is
  larger than one IPC frame: `list_dir` is paged from a single snapshot of the
  directory and returned whole, as in process. A directory of more than
  1,048,576 entries (or 16 MiB of names) is refused with `ResourceLimit` in
  both modes, so the host never holds an unbounded listing (#4220).
