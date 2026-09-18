## Added

- termiHub now runs as a **single instance per user**: launching the app a second time focuses (and un-minimizes) the already-running window and exits, instead of opening a second copy. This prevents two running copies from clobbering each other's shared configuration and last-session files.

## Changed

- A second launch no longer opens a new window — it brings the existing window to the front. This applies to installed builds only; portable copies in separate folders continue to run independently (they use separate data directories and cannot clobber each other).
