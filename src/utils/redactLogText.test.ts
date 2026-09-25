import { describe, it, expect } from "vitest";
import { redactLogText, REDACTION_MARKER } from "./redactLogText";

const MARK = REDACTION_MARKER;

describe("redactLogText — password / passphrase / secret keys", () => {
  const cases: Array<[string, string]> = [
    ["password=hunter2", `password=${MARK}`],
    ["password: hunter2", `password: ${MARK}`],
    ['"password": "hunter2"', `"password": "${MARK}"`],
    ["passphrase=my-key-pass", `passphrase=${MARK}`],
    ["passwd = s3cr3t", `passwd = ${MARK}`],
    ["pwd=abc123", `pwd=${MARK}`],
    ["secret=topsecret", `secret=${MARK}`],
    ["client_secret: 'abcdef'", `client_secret: '${MARK}'`],
  ];

  it.each(cases)("redacts %s", (input, expected) => {
    expect(redactLogText(input)).toBe(expected);
  });

  it("redacts a quoted value containing spaces", () => {
    expect(redactLogText('password="my pass word"')).toBe(`password="${MARK}"`);
  });

  it("keeps surrounding context readable", () => {
    const line = "2026-09-25 [INFO] ssh: connecting with password=hunter2 to host";
    expect(redactLogText(line)).toBe(
      `2026-09-25 [INFO] ssh: connecting with password=${MARK} to host`
    );
  });

  it("is case-insensitive on the key name", () => {
    expect(redactLogText("PassWord=hunter2")).toBe(`PassWord=${MARK}`);
  });
});

describe("redactLogText — tokens and api keys", () => {
  const cases: Array<[string, string]> = [
    ["token=abc.def.ghi", `token=${MARK}`],
    ["access_token: aaaabbbbcccc", `access_token: ${MARK}`],
    ["refresh_token=zzz", `refresh_token=${MARK}`],
    ["api_key=sk-1234567890", `api_key=${MARK}`],
    ["apikey: LIVEKEY", `apikey: ${MARK}`],
    ["access-key=AKIA1234", `access-key=${MARK}`],
    ["secret_key=deadbeef", `secret_key=${MARK}`],
  ];

  it.each(cases)("redacts %s", (input, expected) => {
    expect(redactLogText(input)).toBe(expected);
  });
});

describe("redactLogText — Authorization / Bearer", () => {
  it("redacts a Bearer authorization header, keeping the scheme", () => {
    expect(redactLogText("Authorization: Bearer eyJhbGciOiJ.payload.sig")).toBe(
      `Authorization: Bearer ${MARK}`
    );
  });

  it("redacts a Basic authorization header, keeping the scheme", () => {
    expect(redactLogText("authorization=Basic dXNlcjpwYXNz")).toBe(`authorization=Basic ${MARK}`);
  });

  it("redacts a standalone Bearer token", () => {
    expect(redactLogText("curl -H 'x: Bearer abc123DEF456'")).toBe(`curl -H 'x: Bearer ${MARK}'`);
  });
});

describe("redactLogText — connection-string credentials", () => {
  it("masks the password in ssh://user:pw@host", () => {
    expect(redactLogText("ssh://alice:s3cr3t@example.com:22")).toBe(
      `ssh://alice:${MARK}@example.com:22`
    );
  });

  it("masks the password in a postgres URL, keeping user and host", () => {
    expect(redactLogText("postgres://admin:P%40ss@db.internal/app")).toBe(
      `postgres://admin:${MARK}@db.internal/app`
    );
  });

  it("does not touch a URL with no credentials", () => {
    const url = "https://example.com/path?q=1";
    expect(redactLogText(url)).toBe(url);
  });
});

describe("redactLogText — PEM private key blocks", () => {
  it("collapses an RSA private key block to a single marker", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1234567890abcdef",
      "ghijklmnopqrstuvwxyz0987654321",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactLogText(pem);
    expect(redacted).toBe(`-----BEGIN PRIVATE KEY----- ${MARK}`);
    expect(redacted).not.toContain("MIIEpAIBAAKCAQEA");
  });

  it("redacts an OpenSSH private key block embedded in a log line", () => {
    const text = [
      "loaded key material:",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=",
      "-----END OPENSSH PRIVATE KEY-----",
      "done",
    ].join("\n");
    const redacted = redactLogText(text);
    expect(redacted).toContain("loaded key material:");
    expect(redacted).toContain("done");
    expect(redacted).toContain(MARK);
    expect(redacted).not.toContain("b3BlbnNzaC1rZXktdjEA");
  });
});

describe("redactLogText — non-secret text passes through", () => {
  const passthrough = [
    "2026-09-25 [INFO] terminal: session opened on /dev/ttyUSB0",
    "connecting to example.com on port 22",
    "the word password appears but with no assignment here",
    "keyboard shortcut registered", // must not match on "key"
    "tokenizer initialized", // must not match bare "token"
    "user logged in successfully",
    "GET https://example.com/api/status 200 OK",
  ];

  it.each(passthrough)("leaves %s unchanged", (line) => {
    expect(redactLogText(line)).toBe(line);
  });
});

describe("redactLogText — general properties", () => {
  it("returns empty string unchanged", () => {
    expect(redactLogText("")).toBe("");
  });

  it("is idempotent (re-redacting is a no-op)", () => {
    const once = redactLogText("password=hunter2 token=abc ssh://u:p@h");
    expect(redactLogText(once)).toBe(once);
  });

  it("redacts multiple distinct secrets on one line", () => {
    const input = "password=hunter2 and token=abc123";
    expect(redactLogText(input)).toBe(`password=${MARK} and token=${MARK}`);
  });

  it("redacts secrets across multiple lines independently", () => {
    const input = ["password=hunter2", "harmless line", "api_key=xyz"].join("\n");
    expect(redactLogText(input)).toBe(
      [`password=${MARK}`, "harmless line", `api_key=${MARK}`].join("\n")
    );
  });
});
