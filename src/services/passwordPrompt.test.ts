import { describe, expect, it } from "vitest";
import { isPasswordPrompt, textBeforeCursor } from "./passwordPrompt";

describe("isPasswordPrompt", () => {
  it.each([
    "Password:",
    "Password: ",
    "[sudo] password for arne: ",
    "arne@db-1's password: ",
    "Enter passphrase for key '/home/arne/.ssh/id_ed25519': ",
    "Enter PIN for 'YubiKey': ",
    "Verification code: ",
    "[sudo] Passwort für arne: ",
    "Contraseña: ",
    "Password for admin@example.com：",
  ])("%j is one", (text) => expect(isPasswordPrompt(text)).toBe(true));

  it.each([
    "",
    "arne@web:~$ ",
    "arne@web:~$ passwd",
    "Opinion: ",
    "login: ",
    "Password: hunter2",
    "The password was changed. Press Enter",
  ])("%j is not", (text) => expect(isPasswordPrompt(text)).toBe(false));
});

describe("textBeforeCursor", () => {
  const buffer = (rows: Array<[string, boolean]>, cursorX: number, cursorY: number) => ({
    baseY: 0,
    cursorX,
    cursorY,
    getLine: (y: number) =>
      rows[y] && {
        isWrapped: rows[y][1],
        translateToString: (_trim?: boolean, start = 0, end = rows[y][0].length) =>
          rows[y][0].slice(start, end),
      },
  });

  it("reads the row up to the cursor", () => {
    expect(textBeforeCursor(buffer([["Password: tail", false]], 10, 0))).toBe("Password: ");
  });

  it("joins the rows a prompt wraps over", () => {
    const rows: Array<[string, boolean]> = [
      ["other", false],
      ["Enter passphrase for ", false],
      ["key: ", true],
    ];
    expect(textBeforeCursor(buffer(rows, 5, 2))).toBe("Enter passphrase for key: ");
  });
});
