### Added

- **RDP connections can tunnel through an SSH host** (#4865): the RDP
  connection editor now has the same **SSH Tunnel** group as VNC (SSH host,
  port, username, and password, key file or ssh-agent authentication). With it
  on, termiHub opens an SSH local forward and the RDP session runs through it,
  so a desktop behind a bastion no longer needs a hand-made port forward. The
  SSH host key is checked like any other SSH connection's, the SSH password is
  kept in the credential store, and the tunnel closes with the session and
  reopens on reconnect. NLA and TLS still name the real RDP server. The tunnel
  cannot be combined with connecting through an agent.
- **MobaXterm import maps a single RDP SSH gateway** onto the new RDP SSH
  tunnel instead of leaving a preview note. A chain of several gateways is
  still reported as a note.
