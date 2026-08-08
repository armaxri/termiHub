### Fixed

- Creating a new folder (connection group) or connection on a connected remote
  agent now reliably appears in the Remote Agents sidebar. Two races in the
  authoritative `agents` projection could silently drop the new item even though
  the create succeeded: a create folded against an agent whose region entry had
  not landed yet was discarded, and a once-per-connect refresh snapshot taken
  before the create was persisted could clobber it when delivered afterwards. The
  agents store now records optimistic creates until a server snapshot confirms
  them, so a create survives a racing stale snapshot and renders as soon as the
  agent entry exists — while a locally deleted item still stays deleted. (#2486)
