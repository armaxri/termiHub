# Headless polkit fixture for the Linux OS re-auth verifier (#3553).
#
# A system D-Bus + polkitd with no desktop session, so termiHub's real polkit
# transport (src-tauri/src/credential/os_auth/polkit/dbus.rs, compiled into the
# `polkit-probe` binary) can be driven end to end. `run.sh` mounts the probe and
# the shipped policy file; `scenarios.sh` starts the bus + polkitd itself and
# asserts every outcome. Test user: tester / tester-password (created by
# scenarios.sh). Debian trixie matches the rust:*-trixie image the probe is
# built in, so its glibc is compatible.
FROM debian:trixie

# Harden apt against transient mirror failures in CI (#2768).
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-ci-retries

# polkitd ships pkttyagent and the setuid polkit-agent-helper-1 (real PAM
# password check); expect gives pkttyagent the tty it insists on.
RUN apt-get update && apt-get install -y --no-install-recommends \
        dbus \
        polkitd \
        expect \
    && rm -rf /var/lib/apt/lists/* \
    # No bus activation: polkitd runs only while scenarios.sh has started it,
    # so the "polkit not running" case is deterministic.
    && rm /usr/share/dbus-1/system-services/org.freedesktop.PolicyKit1.service

COPY scenarios.sh pkttyagent.exp /fixture/

ENTRYPOINT ["/fixture/scenarios.sh"]
