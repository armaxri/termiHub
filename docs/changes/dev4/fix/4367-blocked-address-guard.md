### Security

- Plugins: a native plugin's network connections can no longer reach this
  computer (`localhost`) or private networks unless its manifest sets
  `connectionPolicy.allowLocalNetwork`, which the plugin's access summary shows.
  Link-local addresses and cloud metadata endpoints are never reachable. The
  host name is resolved once and only allowed addresses are connected, and a
  refused connection is reported like any other denied plugin request (#4367).
- HTTP monitor: the Alibaba Cloud (`100.100.100.200`) and AWS IPv6
  (`fd00:ec2::254`) metadata addresses are now always blocked, also with
  "Allow internal / private targets" on. The shared address range
  `100.64.0.0/10` and NAT64 forms of blocked addresses are now treated like the
  addresses they stand for (#4367).
