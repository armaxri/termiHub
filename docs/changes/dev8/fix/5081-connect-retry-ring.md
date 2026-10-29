### Fixed

- The connecting screen no longer gets stuck on "Connecting…". Abort, the
  connect timeout and a failed retry now really end the attempt: the
  connection attempt is cancelled and the screen shows a final state with
  Retry and Close tab. Before, only the first attempt could finish, and
  Abort → Retry connected forever (#5081).
- Every attempt now starts its own timeout ring, which fills over the full
  timeout. Before, the ring could start filling, drop back and then stay empty
  (#5081).
