# SSH server with password auth + a password-required sudoer, for the
# elevated remote-save integration test (#1494 / #1328).
#
# Test user:  testuser / testpass  — member of the `sudo` group, so
#             `sudo` requires the account password (NOT NOPASSWD).
# Target:     /etc/termihub-elevated-target.txt — root:root, mode 644, known
#             contents. `write_file_content_elevated` rewrites it in place via
#             `sudo -S` while preserving owner/mode.
#
# German-locale users (#4437) — prove the elevated save classifies sudo's
# outcome without reading translated text, on a remote whose login locale is
# NOT English. sshd sets `LANG=de_DE.UTF-8` / `LANGUAGE=de_DE:de` for these two
# accounts only (`Match User` + `SetEnv`), so `testuser` keeps the C locale the
# other tests expect.
#   deuser   / testpass — password-required sudoer, German login locale.
#   denosudo / testpass — NOT a sudoer, German login locale (sudo authenticates,
#                         then refuses: the not-in-sudoers outcome).
FROM ubuntu:24.04

# Harden apt against transient mirror failures in CI (#2768).
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-ci-retries

# The minimized Ubuntu image drops every installed `.mo` translation via a dpkg
# path-exclude; keep translations so the German sudo/PAM messages exist (#4437).
# Ubuntu ships main-package translations (sudo, Linux-PAM) in the language
# packs, so `language-pack-de-base` provides them and `locales` the de_DE.UTF-8
# locale itself.
RUN if [ -f /etc/dpkg/dpkg.cfg.d/excludes ]; then \
        sed -i '\#/usr/share/locale#d' /etc/dpkg/dpkg.cfg.d/excludes; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    sudo \
    locales \
    language-pack-de-base \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Generate the German locale and fail the build early if it or sudo's German
# catalog is missing — otherwise the German-locale test would fail obscurely.
RUN locale-gen de_DE.UTF-8 \
    && locale -a | grep -qix 'de_DE.utf8' \
    && find /usr/share/locale-langpack /usr/share/locale \
        -path '*/de/LC_MESSAGES/sudo.mo' 2>/dev/null | grep -q .

# Create test user and make it a password-required sudoer via the `sudo` group
# (Ubuntu's default `%sudo ALL=(ALL:ALL) ALL` — password required, no NOPASSWD).
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd \
    && usermod -aG sudo testuser

# German-locale accounts (#4437): `deuser` is a password-required sudoer like
# `testuser`; `denosudo` is deliberately not in the `sudo` group.
RUN useradd -m -s /bin/bash deuser \
    && echo "deuser:testpass" | chpasswd \
    && usermod -aG sudo deuser \
    && useradd -m -s /bin/bash denosudo \
    && echo "denosudo:testpass" | chpasswd

# Root-owned target file the elevated save rewrites (contents intentionally
# distinct from anything the test writes, so "unchanged" is unambiguous).
RUN printf 'original-root-owned-content\n' > /etc/termihub-elevated-target.txt \
    && chown root:root /etc/termihub-elevated-target.txt \
    && chmod 644 /etc/termihub-elevated-target.txt

# Configure SSH: allow password auth
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config \
    && printf '\nMatch User deuser,denosudo\n    SetEnv LANG=de_DE.UTF-8 LANGUAGE=de_DE:de\n' \
        >> /etc/ssh/sshd_config

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
