### Changed

- RDP: Test connection on a server whose certificate is not trusted yet now shows the
  certificate dialog instead of failing with "not trusted yet". Accept it once, or accept and
  remember it for the host, and the test goes on to check the credentials. Rejecting or
  closing the dialog, cancelling the test, or leaving the dialog unanswered for two minutes
  trusts nothing (#4510).
