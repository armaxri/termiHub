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

FROM ubuntu:24.04

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

# Deploy the pre-built agent binary to the POSIX default install path. The file
# is staged into the build context by the harness fixture before `build`.
COPY termihub-agent /home/testuser/.local/bin/termihub-agent
RUN chown -R testuser:testuser /home/testuser/.local && \
    chmod 755 /home/testuser/.local/bin/termihub-agent

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
