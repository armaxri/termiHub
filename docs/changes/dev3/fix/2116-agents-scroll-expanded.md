### Fixed

- Remote Agents sidebar: the agent list now scrolls correctly even when agents
  are expanded, and expanding an agent no longer clips its contents. The list
  previously flex-distributed the expanded agents over a fixed height, so it
  never overflowed (no top-level scroll) and each expanded agent's tree was
  squeezed into an unreadable clipped slice. Every agent now renders at its
  natural content height inside a single scroll container, so the whole list
  scrolls with the header and filter pinned and every agent — collapsed or
  expanded — is fully reachable and readable (#2116).
