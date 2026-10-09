### Fixed

- Network tools and agent setup: closing the Ping or HTTP Monitor tab, or the
  agent setup dialog, while a start was still being set up no longer leaves a
  background event listener behind, and a ping that finished starting after
  its tab closed is now stopped instead of running on unseen (#4576).
