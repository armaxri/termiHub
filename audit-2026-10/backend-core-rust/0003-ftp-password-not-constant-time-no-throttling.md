---
id: CORE2-003
title: "Embedded FTP password check is not constant-time and has no failed-login throttling (per-session libunftp instances reset any policy)"
angle: backend-core-rust
severity: low
category: security
is_workaround: false
subsystem: core/embedded_servers/ftp
evidence:
  - core/src/embedded_servers/ftp_server.rs:701
  - core/src/embedded_servers/ftp_server.rs:707
  - core/src/embedded_servers/ftp_server.rs:710
  - core/src/embedded_servers/ftp_server.rs:95
  - core/src/embedded_servers/ftp_server.rs:256
  - core/src/embedded_servers/http_server.rs:279
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`FtpAuthenticator::accepts` compares the password with `pw == expected_pass.as_str()` and the username with `==`. Both are early-exit byte comparisons. The HTTP server's Basic auth uses a hashed constant-time `secret_eq` (`subtle::ct_eq`). `server_builder` also configures no `failed_logins_policy`, and since #3996 a fresh libunftp `Server` is built per control connection (`start_backend`). Any libunftp per-IP lockout would therefore reset on every reconnect, so nothing limits the attempt rate.

## Why it matters

With credentials auth on a LAN-exposed embedded FTP server, an attacker can brute-force the password at full connection rate (bounded only by the unbounded-session issue above), and gets a timing oracle for free. It is inconsistent with the HTTP server's deliberate constant-time comparison. Severity is low because the default bind is loopback and FTP sends credentials in plaintext anyway.

## Recommendation

Reuse the HTTP server's `secret_eq` (move it into a shared embedded_servers helper) for both username and password. Keep the comparison free of short-circuits by evaluating both `Choice`s and combining them with `&`. Because libunftp instances are per session, implement throttling in termiHub's own layer: keep a server-wide `HashMap<IpAddr, (failures, window_start)>` in `ServerActivity` or in the relay. Refuse a client IP for a back-off period after N failed LOGIN records (for example 5 in 60 s): the authenticator returns `BadPassword` without comparing, or the relay answers `421`. Add a unit test for the lockout window.

## Verification

Confirmed. FtpAuthenticator::accepts (ftp_server.rs:701-713) compares with `pw == expected_pass.as_str()` and `username == expected_user`, both early-exit comparisons. The HTTP server uses the hashed constant-time secret_eq (http_server.rs:280). server_builder (ftp_server.rs:95-123) sets no failed_logins_policy. Because a libunftp server is built per session, any per-instance throttling would reset on each reconnect anyway. Low fits: the default bind is loopback and FTP sends credentials in plaintext, so the timing oracle adds little over network sniffing.
