### Security

- Biometric unlock of the master-password store now binds its key to OS-enforced
  access control where available (#3534): on Windows the key is derived from a
  Windows Hello key-credential signature, so it only exists after Hello verified
  you; code-signed macOS builds keep it in the data-protection keychain behind
  Touch ID (`biometryCurrentSet`). Builds without that support (including the
  unsigned macOS beta) keep the previous behaviour, and Settings → Security shows
  "OS-enforced: yes / no" under the toggle. Existing enrollments keep working and
  are upgraded automatically the next time you unlock with biometrics.
