### Fixed

- Agent deploy/update: an update whose install step failed on the remote host
  (for example `mv` refused with "Permission denied") was reported as a
  successful update, showing the old agent's version. termiHub now fails the
  deploy with the remote error, removes the uploaded binary and leaves the
  previously installed agent untouched.
- Agent deploy/update: an upload that failed part-way (a write error rather
  than a cancel) left a half-written `termihub-agent` in the remote upload
  directory. Every failed upload is now rolled back, and a rollback that
  itself fails is included in the error message.
