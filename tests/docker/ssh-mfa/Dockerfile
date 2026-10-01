# SSH server that requires TWO factors (#3384), modelling a real 2FA deployment:
#
#   AuthenticationMethods password,keyboard-interactive publickey,keyboard-interactive
#
# A correct password (or authorized key) is a PARTIAL success (USERAUTH_FAILURE
# with partial_success = 1), after which keyboard-interactive asks for a one-time
# code. The in-process russh test server cannot emit that flag (russh clears it),
# so this fixture is what proves the client's `KiMode::SecondFactor` path live.
#
# Test user:  testuser / testpass, plus every key in tests/fixtures/ssh-keys
# OTP:        fixed code 424242, asked as "Verification code: " by a tiny
#             test-only PAM module (pam_fixture_otp.c).

# ── Build the fixture PAM module ─────────────────────────────────────
FROM ubuntu:24.04 AS pam-build

# Harden apt against transient mirror failures in CI (#2768).
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-ci-retries

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libc6-dev libpam0g-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pam_fixture_otp.c /src/pam_fixture_otp.c
RUN gcc -Wall -Werror -shared -fPIC -o /src/pam_fixture_otp.so /src/pam_fixture_otp.c -lpam

# ── Runtime ──────────────────────────────────────────────────────────
FROM ubuntu:24.04

# Harden apt against transient mirror failures in CI (#2768).
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-ci-retries

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd

RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
COPY --from=keys authorized_keys /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys \
    && chown -R testuser:testuser /home/testuser/.ssh

COPY --from=pam-build /src/pam_fixture_otp.so /usr/local/lib/security/pam_fixture_otp.so

# Replace the auth stack: the fixture OTP module first (success ends the stack),
# then pam_unix checking whatever it stored as the password — without prompting.
RUN sed -i 's|^@include common-auth|auth [success=done default=ignore] /usr/local/lib/security/pam_fixture_otp.so\nauth requisite pam_unix.so use_first_pass nodelay|' \
    /etc/pam.d/sshd \
    && grep -q pam_fixture_otp /etc/pam.d/sshd

# sshd keeps the FIRST value it reads; sshd_config.d/ is included at the top of
# sshd_config, so this drop-in wins over the stock `KbdInteractiveAuthentication no`.
RUN printf '%s\n' \
    'UsePAM yes' \
    'PasswordAuthentication yes' \
    'KbdInteractiveAuthentication yes' \
    'PubkeyAuthentication yes' \
    'AuthenticationMethods password,keyboard-interactive publickey,keyboard-interactive' \
    'PermitRootLogin no' \
    'UseDNS no' \
    > /etc/ssh/sshd_config.d/10-mfa.conf

RUN ssh-keygen -A && /usr/sbin/sshd -t

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
