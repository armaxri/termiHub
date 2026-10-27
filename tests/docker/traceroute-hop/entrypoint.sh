#!/bin/sh
# Multi-hop traceroute fixture (#4964, MT-NET-16).
#
# The desktop app runs on the Docker HOST, which sits on network A's bridge as
# its gateway ($NET_A.1). The trace target $NET_A.200 looks on-link to the
# host, but it actually lives two routers away:
#
#   host $NET_A.1 --A-- router1 $NET_A.2 / $NET_B.2 --B-- router2 $NET_B.3 /
#   $NET_C.2 --C-- target $NET_C.3 (+ $NET_A.200/32)
#
# router1 answers the host's ARP for $NET_A.200 (proxy ARP, set by the compose
# sysctls), so the host hands the probe to router1 without any host route or
# privilege. Static routes then forward it router1 -> router2 -> target, and
# the replies come back the same way. The hops are therefore exactly:
#
#   1  $NET_A.2    (router1, Time Exceeded)
#   2  $NET_B.3    (router2, Time Exceeded)
#   3  $NET_A.200  (target, Port Unreachable)
#
# NET_A / NET_B / NET_C are three-octet prefixes (e.g. 10.231.0), offset per
# checkout by the harness so parallel checkouts never share a subnet.
set -eu

: "${ROLE:?ROLE must be router1, router2 or target}"
: "${NET_A:?}" "${NET_B:?}" "${NET_C:?}"
TARGET="$NET_A.200"

case "$ROLE" in
router1)
    ip route replace "$TARGET/32" via "$NET_B.3"
    ;;
router2)
    ip route replace "$TARGET/32" via "$NET_C.3"
    ip route replace "$NET_A.0/24" via "$NET_B.2"
    ;;
target)
    dev=$(ip -o -4 addr show | awk -v want="$NET_C.3/" 'index($4, want) == 1 { print $2 }')
    ip addr add "$TARGET/32" dev "$dev"
    ip route replace "$NET_A.0/24" via "$NET_C.2"
    ;;
*)
    echo "unknown ROLE '$ROLE'" >&2
    exit 1
    ;;
esac

ip -4 route show >&2
touch /tmp/ready
# PID 1 ignores SIGTERM by default; exit on it so `compose down` is instant.
trap 'exit 0' TERM INT
while :; do
    sleep 3600 &
    wait $!
done
