# termiHub Remote Agent test container
#
# Provides an SSH-accessible host with the `termihub-agent` binary
# **pre-installed** for the live-connect E2E tests (#995).
#
# The agent binary is not committed to the repo — it is a static-musl build
# cross-compiled for the container architecture and staged into this build
# context by the Python harness fixture (`remote_agent_fixtures`) right before
# the image is built. See `tests/system/termihub_harness/fixtures.py`
# (`stage_remote_agent_binary`). The staged file is git-ignored (see the sibling
# `.gitignore`).
#
# Usage (normally driven by the harness, not by hand):
#   ./scripts/build-agents.sh --targets x86_64-unknown-linux-musl
#   cp target/x86_64-unknown-linux-musl/release/termihub-agent \
#      tests/docker/remote-agent/termihub-agent
#   docker compose -f tests/docker/docker-compose.yml --profile agent build remote-agent
#   docker compose -f tests/docker/docker-compose.yml --profile agent up -d
#   # Connects on port 2211 (testuser/testpass) with the agent already deployed.
#
# The agent is installed to `~testuser/.local/bin/termihub-agent`, the POSIX
# default path the desktop probes and launches (`$HOME/.local/bin/termihub-agent
# --stdio`; see `src-tauri/src/terminal/backend.rs`), so a live connect finds it
# without any setup wizard step.

FROM ubuntu:24.04 AS agent

# Harden apt against transient mirror failures in CI (#2768).
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-ci-retries

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    && rm -rf /var/lib/apt/lists/*

# Create test user
RUN useradd -m -s /bin/bash testuser && \
    echo "testuser:testpass" | chpasswd

# Configure SSH
RUN mkdir -p /run/sshd && \
    sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

# Copy SSH keys for key-based auth
COPY --from=keys authorized_keys /home/testuser/.ssh/authorized_keys
RUN chown -R testuser:testuser /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    chmod 600 /home/testuser/.ssh/authorized_keys

# ── Deferred-update E2E arming (#1520 / #1546) ──────────────────────────────────
# When PENDING_UPDATE_VERSION is a non-empty build arg, arm this image so the
# desktop-launched agent holds a `pending_update` and announces it on attach — the
# only way to drive the banner's "Apply Now → deferred/busy" path live, since the
# gating env var (TERMIHUB_AGENT_TEST_PENDING_UPDATE) is deliberately not a CLI
# flag and can never appear in the desktop's SSH exec command (see the hook docs,
# agent/src/update/test_hook.rs). The var reaches the agent process via sshd's
# per-user environment file: `PermitUserEnvironment yes` makes sshd apply
# ~testuser/.ssh/environment to exec channels (the `termihub-agent --stdio` launch),
# so a `pending_update` is staged on every connect. The default image leaves this
# arg empty and behaves byte-for-byte as before — only the dedicated
# `remote-agent-pending-update` compose service passes a version.
ARG PENDING_UPDATE_VERSION=""
RUN if [ -n "$PENDING_UPDATE_VERSION" ]; then \
        printf 'PermitUserEnvironment yes\n' >> /etc/ssh/sshd_config && \
        printf 'TERMIHUB_AGENT_TEST_PENDING_UPDATE=%s\n' "$PENDING_UPDATE_VERSION" \
            > /home/testuser/.ssh/environment && \
        chown testuser:testuser /home/testuser/.ssh/environment && \
        chmod 600 /home/testuser/.ssh/environment; \
    fi

# ── Keyboard-interactive-only transport (#4005 / #3377) ─────────────────────────
# When KBDINT_ONLY is a non-empty build arg, sshd accepts ONLY keyboard-interactive
# auth: PAM's pam_unix asks "Password: " as a keyboard-interactive prompt (not the
# SSH password method), so a remote agent whose auth method is
# "Keyboard-Interactive (OTP / 2FA)" must answer it in the desktop's in-app prompt.
# The live driver for the agent-transport KI connect (the `remote-agent-kbdint`
# compose service). sshd keeps the FIRST value it reads and sshd_config.d/ is
# included at the top of sshd_config, so this drop-in wins over the stock
# `KbdInteractiveAuthentication no`. The default image leaves the arg empty.
ARG KBDINT_ONLY=""
RUN if [ -n "$KBDINT_ONLY" ]; then \
        printf '%s\n' \
            'UsePAM yes' \
            'KbdInteractiveAuthentication yes' \
            'PasswordAuthentication no' \
            'PubkeyAuthentication no' \
            'AuthenticationMethods keyboard-interactive' \
            > /etc/ssh/sshd_config.d/10-kbdint-only.conf; \
    fi

# Deploy the pre-built agent binary to the POSIX default install path. The file
# is staged into the build context by the harness fixture before `build`.
COPY termihub-agent /home/testuser/.local/bin/termihub-agent
RUN chown -R testuser:testuser /home/testuser/.local && \
    chmod 755 /home/testuser/.local/bin/termihub-agent

# Generate host keys (and validate the final config)
RUN ssh-keygen -A && /usr/sbin/sshd -t

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]

# ── Real-swap deferred-update arming (#4083) ────────────────────────────────────
# Build target `update-swap` (the `remote-agent-update-swap` compose service; build
# it together with PENDING_UPDATE_VERSION). On top of the armed image above it
# stages a REAL update the agent can apply: a copy of the deployed agent with a
# trailer appended (so its bytes, and SHA-256, differ while it stays a launchable
# agent of the same version), signed exactly the way release CI signs
# (`openssl pkeyutl -sign -rawin` over "termihub-agent-update-v1\0" || SHA-256) —
# but with the committed TEST-ONLY key (agent/keys/test-only/, bind-mounted from
# the `update-test-key` build context so it never lands in an image layer). Only
# a `test-hooks` agent trusts that key; the apply runs the unchanged production
# digest (AGT-004) and signature (AGT-005) checks. The hook learns the staged
# path and digest from sshd's per-user environment file; it reads the signature
# from the `.sig` sidecar. See agent/src/update/test_hook.rs.
FROM agent AS update-swap

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

RUN --mount=type=bind,from=update-test-key,target=/run/update-test-key \
    set -eu; \
    [ -f /home/testuser/.ssh/environment ] || { \
        echo "update-swap needs PENDING_UPDATE_VERSION (the armed hook)" >&2; exit 1; }; \
    updates=/home/testuser/.config/termihub-agent/updates; \
    staged="$updates/termihub-agent-swap-test"; \
    mkdir -p "$updates"; \
    cp /home/testuser/.local/bin/termihub-agent "$staged"; \
    printf '\nTERMIHUB-TEST-SWAPPED-AGENT-BUILD (#4083)\n' >> "$staged"; \
    chmod 755 "$staged"; \
    digest="$(sha256sum "$staged" | cut -c1-64)"; \
    { printf 'termihub-agent-update-v1\0'; openssl dgst -sha256 -binary "$staged"; } > /tmp/msg; \
    openssl pkeyutl -sign -rawin \
        -inkey /run/update-test-key/update-signing-TEST-ONLY.key.pem -in /tmp/msg \
        | openssl base64 -A > "$staged.sig"; \
    openssl base64 -d -A -in "$staged.sig" -out /tmp/sig.bin; \
    openssl pkeyutl -verify -rawin -pubin \
        -inkey /run/update-test-key/update-signing-TEST-ONLY.pub.pem \
        -in /tmp/msg -sigfile /tmp/sig.bin; \
    rm -f /tmp/msg /tmp/sig.bin; \
    printf '%s  %s\n' "$digest" termihub-agent-swap-test > "$staged.sha256"; \
    printf 'TERMIHUB_AGENT_TEST_PENDING_UPDATE_BINARY=%s\nTERMIHUB_AGENT_TEST_PENDING_UPDATE_SHA256=%s\n' \
        "$staged" "$digest" >> /home/testuser/.ssh/environment; \
    chown -R testuser:testuser /home/testuser/.config; \
    /usr/sbin/sshd -t

# Default target: the plain (or PENDING_UPDATE_VERSION-armed) image above.
FROM agent
