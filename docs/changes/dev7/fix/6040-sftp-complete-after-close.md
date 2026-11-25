### Fixed

- An SFTP upload is shown as complete only when the server has closed the file. It can be opened right away then, on Windows servers too, and an upload the server could not store is no longer shown as complete (#6040).
- A copy inside one SFTP server reports a failure the server announces when it closes the file (#6040).
- After a failed or cancelled SFTP transfer the next attempt and the removal of the partial file no longer fail because the server still has it open (#6040).
- When an SFTP server refuses to open a file without saying why, the message says that the file may still be open, for example in a connection that was lost (#6040).
