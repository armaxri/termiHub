### Fixed

- A mistyped one-time code no longer throws away your saved SSH password. When the saved
  password was accepted but the verification code you typed (keyboard-interactive / OTP / 2FA)
  was rejected, termiHub now says "Verification code rejected — try again" and keeps the saved
  password, instead of reporting "Authentication failed" and deleting it. Applies to direct
  connections, jump-host hops, remote agents and Test Connection. A rejected saved password is
  still cleared and re-prompted as before (#3376).
