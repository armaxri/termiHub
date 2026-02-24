#!/bin/bash
# Network fault injection control script
# Called via symlinks: apply-latency, apply-loss, apply-throttle, etc.
# Uses tc/netem on eth0 to simulate network conditions
set -e

IFACE="eth0"
COMMAND=$(basename "$0")

usage() {
    cat <<EOF
Network Fault Control for termiHub Testing

Commands (via symlink or first argument):
  apply-latency <delay>       Add latency (e.g., 500ms, 2s)
  apply-jitter <delay> <var>  Add latency with jitter (e.g., 100ms 50ms)
  apply-loss <percent>        Add packet loss (e.g., 10%, 50%)
  apply-corrupt <percent>     Corrupt packets (e.g., 5%)
  apply-throttle <rate>       Bandwidth limit (e.g., 56kbit, 1mbit)
  apply-disconnect            Drop all packets (simulates disconnect)
  reset-faults                Remove all network conditions

Examples:
  apply-latency 500ms                  # 500ms latency on all packets
  apply-jitter 200ms 50ms             # 200ms +/- 50ms latency
  apply-loss 10%                       # 10% packet loss
  apply-throttle 1mbit                 # 1 Mbit/s bandwidth limit
  apply-disconnect                     # Total network blackout
  reset-faults                         # Back to normal
EOF
}

reset_netem() {
    tc qdisc del dev "$IFACE" root 2>/dev/null || true
    echo "All network conditions reset on $IFACE"
}

case "$COMMAND" in
    apply-latency)
        DELAY="${1:?Usage: apply-latency <delay> (e.g., 500ms)}"
        reset_netem
        tc qdisc add dev "$IFACE" root netem delay "$DELAY"
        echo "Applied latency: $DELAY on $IFACE"
        ;;
    apply-jitter)
        DELAY="${1:?Usage: apply-jitter <delay> <variation> (e.g., 200ms 50ms)}"
        VAR="${2:?Usage: apply-jitter <delay> <variation>}"
        reset_netem
        tc qdisc add dev "$IFACE" root netem delay "$DELAY" "$VAR" distribution normal
        echo "Applied jitter: $DELAY +/- $VAR on $IFACE"
        ;;
    apply-loss)
        LOSS="${1:?Usage: apply-loss <percent> (e.g., 10%)}"
        reset_netem
        tc qdisc add dev "$IFACE" root netem loss "$LOSS"
        echo "Applied packet loss: $LOSS on $IFACE"
        ;;
    apply-corrupt)
        RATE="${1:?Usage: apply-corrupt <percent> (e.g., 5%)}"
        reset_netem
        tc qdisc add dev "$IFACE" root netem corrupt "$RATE"
        echo "Applied packet corruption: $RATE on $IFACE"
        ;;
    apply-throttle)
        RATE="${1:?Usage: apply-throttle <rate> (e.g., 1mbit, 56kbit)}"
        reset_netem
        tc qdisc add dev "$IFACE" root tbf rate "$RATE" burst 32kbit latency 400ms
        echo "Applied bandwidth throttle: $RATE on $IFACE"
        ;;
    apply-disconnect)
        reset_netem
        tc qdisc add dev "$IFACE" root netem loss 100%
        echo "Applied disconnect (100% packet loss) on $IFACE"
        ;;
    reset-faults|reset)
        reset_netem
        ;;
    fault-control)
        # Called directly — use first argument as command
        SUBCMD="${1:-help}"
        shift || true
        exec "$0" --as="$SUBCMD" "$@"
        ;;
    *)
        usage
        exit 1
        ;;
esac
