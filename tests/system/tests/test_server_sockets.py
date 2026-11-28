"""Reading the server side of the app's connections to a loopback sshd (#5449).

App-free, in the normal lane: the parser for ``netstat -an`` on macOS
and Windows, and which rows count as held by the server.
"""

from __future__ import annotations

from termihub_harness.server_sockets import SocketRow, parse_netstat, server_held

MACOS = """Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.22400        127.0.0.1.64915        ESTABLISHED
tcp4       0      0  127.0.0.1.64915        127.0.0.1.22400        ESTABLISHED
tcp6       0      0  ::1.22400              ::1.50001              CLOSE_WAIT
tcp4       0      0  *.22400                *.*                    LISTEN
"""

WINDOWS = """
Active Connections

  Proto  Local Address          Foreign Address        State
  TCP    127.0.0.1:22400        127.0.0.1:64915        ESTABLISHED
  TCP    127.0.0.1:64915        127.0.0.1:22400        ESTABLISHED
  TCP    [::1]:22400            [::1]:50001            CLOSE_WAIT
  TCP    0.0.0.0:22400          0.0.0.0:0              LISTENING
"""


def test_both_netstat_formats_parse_to_the_same_rows():
    want = [
        SocketRow(22400, 64915, "ESTABLISHED"),
        SocketRow(64915, 22400, "ESTABLISHED"),
        SocketRow(22400, 50001, "CLOSE_WAIT"),
    ]
    assert parse_netstat(MACOS)[:3] == want
    assert parse_netstat(WINDOWS)[:3] == want


def test_the_server_holds_only_the_app_ports_that_are_up_or_unclosed():
    rows = parse_netstat(WINDOWS)
    assert server_held(rows, 22400, {64915, 50001}) == 2
    assert server_held(rows, 22400, {64915}) == 1
    # Another worker's connection on the same sshd never counts.
    assert server_held(rows, 22400, {12345}) == 0
    # A listener has no foreign port of the app.
    assert server_held([SocketRow(22400, 0, "LISTEN")], 22400, {0}) == 0
