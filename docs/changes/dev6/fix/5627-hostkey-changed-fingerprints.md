### Changed

- SSH: the "Host key changed" dialog now shows the previously trusted key above
  the newly presented one, each with its key type, also when the old key came
  from `~/.ssh/known_hosts`. The remember button reads "Replace trusted key",
  and the hint says it replaces the old key for the host (#5627).

### Security

- SSH: replacing a changed host key now stops trusting the old key for that
  host, instead of trusting both (#5627).
