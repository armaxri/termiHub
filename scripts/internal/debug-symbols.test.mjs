// Tests for debug-symbols.mjs (#4504): build-id extraction from synthetic ELF,
// Mach-O, PE and PDB images, and the stage/check flow for the formats that need
// no external tool. The ELF split itself (objcopy) is exercised for real by
// check-release-crash-symbols.sh and by every release build.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST,
  checkDir,
  identify,
  identifyBuffer,
  parseManifest,
  pdbGuidString,
  stage,
  verifyMatch,
} from "./debug-symbols.mjs";

const UUID = Buffer.from("4c4c44a355553144a1b20123456789ab", "hex");
const BUILD_ID = Buffer.from("c234079f19693415f2765224e43b35c5bd340869", "hex");

/** A 64-bit LE ELF with a build-id note and (optionally) a .debug_line section. */
function elf({ buildId = BUILD_ID, debug = true } = {}) {
  const note = Buffer.alloc(16 + buildId.length);
  note.writeUInt32LE(4, 0);
  note.writeUInt32LE(buildId.length, 4);
  note.writeUInt32LE(3, 8);
  note.write("GNU\0", 12, "latin1");
  buildId.copy(note, 16);
  const debugData = Buffer.from("line table bytes");
  const shstrtab = Buffer.from("\0.note.gnu.build-id\0.debug_line\0.shstrtab\0", "latin1");
  const noteAt = 0x40;
  const debugAt = noteAt + note.length;
  const strAt = debugAt + debugData.length;
  const shoff = (strAt + shstrtab.length + 7) & ~7;
  const sections = [
    { name: 0, type: 0, offset: 0, size: 0, align: 0 },
    { name: 1, type: 7, offset: noteAt, size: note.length, align: 4 },
    { name: 20, type: debug ? 1 : 8, offset: debugAt, size: debugData.length, align: 1 },
    { name: 32, type: 3, offset: strAt, size: shstrtab.length, align: 1 },
  ];
  const buf = Buffer.alloc(shoff + sections.length * 64);
  buf.write("\x7fELF", 0, "latin1");
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // little-endian
  buf.writeBigUInt64LE(BigInt(shoff), 0x28);
  buf.writeUInt16LE(64, 0x3a);
  buf.writeUInt16LE(sections.length, 0x3c);
  buf.writeUInt16LE(3, 0x3e);
  note.copy(buf, noteAt);
  debugData.copy(buf, debugAt);
  shstrtab.copy(buf, strAt);
  sections.forEach((s, i) => {
    const at = shoff + i * 64;
    buf.writeUInt32LE(s.name, at);
    buf.writeUInt32LE(s.type, at + 4);
    buf.writeBigUInt64LE(BigInt(s.offset), at + 0x18);
    buf.writeBigUInt64LE(BigInt(s.size), at + 0x20);
    buf.writeBigUInt64LE(BigInt(s.align), at + 0x30);
  });
  return buf;
}

/** A thin 64-bit Mach-O with one filler load command and LC_UUID. */
function macho(uuid = UUID) {
  const buf = Buffer.alloc(32 + 16 + 24);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(2, 16); // ncmds
  buf.writeUInt32LE(40, 20); // sizeofcmds
  buf.writeUInt32LE(0x19, 32);
  buf.writeUInt32LE(16, 36);
  buf.writeUInt32LE(0x1b, 48);
  buf.writeUInt32LE(24, 52);
  uuid.copy(buf, 56);
  return buf;
}

/** A PE32+ image whose CodeView record names `pdb` with `guid` / `age`. */
function pe({ guid = UUID, age = 1, pdb = "termihub.pdb" } = {}) {
  const buf = Buffer.alloc(0x600);
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "latin1");
  const coff = 0x84;
  buf.writeUInt16LE(1, coff + 2); // one section
  buf.writeUInt16LE(240, coff + 16); // optional header size
  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt);
  buf.writeUInt32LE(16, opt + 108);
  buf.writeUInt32LE(0x1000, opt + 112 + 48); // debug directory RVA
  buf.writeUInt32LE(28, opt + 112 + 52);
  const sec = opt + 240;
  buf.write(".rdata", sec, "latin1");
  buf.writeUInt32LE(0x200, sec + 8);
  buf.writeUInt32LE(0x1000, sec + 12);
  buf.writeUInt32LE(0x200, sec + 16);
  buf.writeUInt32LE(0x400, sec + 20);
  buf.writeUInt32LE(2, 0x400 + 12); // CODEVIEW
  buf.writeUInt32LE(24 + pdb.length + 1, 0x400 + 16);
  buf.writeUInt32LE(0x1020, 0x400 + 20);
  buf.writeUInt32LE(0x420, 0x400 + 24);
  buf.write("RSDS", 0x420, "latin1");
  guid.copy(buf, 0x424);
  buf.writeUInt32LE(age, 0x434);
  buf.write(`${pdb}\0`, 0x438, "utf8");
  return buf;
}

/** A minimal MSF 7.00 PDB: info stream (1) with `guid`, DBI stream (3) with `age`. */
function pdb({ guid = UUID, age = 1 } = {}) {
  const bs = 512;
  const buf = Buffer.alloc(bs * 5);
  buf.write("Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0", 0, "latin1");
  buf.writeUInt32LE(bs, 32);
  buf.writeUInt32LE(5, 40);
  const dir = [4, 0, 28, 0, 12, 3, 4]; // 4 streams, sizes, then blocks of 1 and 3
  buf.writeUInt32LE(dir.length * 4, 44);
  buf.writeUInt32LE(1, 52); // block map in block 1
  buf.writeUInt32LE(2, bs); // directory in block 2
  dir.forEach((v, i) => buf.writeUInt32LE(v, 2 * bs + i * 4));
  buf.writeUInt32LE(20000404, 3 * bs);
  buf.writeUInt32LE(age + 5, 3 * bs + 8); // info age is NOT the matching age
  guid.copy(buf, 3 * bs + 12);
  buf.writeUInt32LE(age, 4 * bs + 8);
  return buf;
}

describe("identifyBuffer", () => {
  it("reads an ELF build-id and whether it carries DWARF", () => {
    expect(identifyBuffer(elf())).toEqual({
      format: "elf",
      id: BUILD_ID.toString("hex"),
      hasDwarf: true,
    });
    expect(identifyBuffer(elf({ debug: false })).hasDwarf).toBe(false);
  });

  it("reads a Mach-O UUID like dwarfdump --uuid", () => {
    expect(identifyBuffer(macho())).toEqual({
      format: "macho",
      id: "4C4C44A3-5555-3144-A1B2-0123456789AB",
    });
  });

  it("reads every slice of a universal Mach-O", () => {
    const a = macho();
    const b = macho(Buffer.alloc(16, 0x11));
    const fat = Buffer.alloc(0x1000 + b.length);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x100, 8 + 8);
    fat.writeUInt32BE(0x1000, 8 + 20 + 8);
    a.copy(fat, 0x100);
    b.copy(fat, 0x1000);
    expect(identifyBuffer(fat).id).toBe(
      "11111111-1111-1111-1111-111111111111,4C4C44A3-5555-3144-A1B2-0123456789AB"
    );
  });

  it("reads a PE's CodeView GUID, age and PDB name", () => {
    expect(identifyBuffer(pe({ age: 3 }))).toEqual({
      format: "pe",
      id: "A3444C4C-5555-4431-A1B2-0123456789AB/3",
      pdb: "termihub.pdb",
    });
  });

  it("reads a PDB's GUID and its DBI (matching) age", () => {
    expect(identifyBuffer(pdb({ age: 3 }))).toEqual({
      format: "pdb",
      id: "A3444C4C-5555-4431-A1B2-0123456789AB/3",
    });
  });

  it("formats a Windows GUID with little-endian leading fields", () => {
    expect(pdbGuidString(UUID)).toBe("A3444C4C-5555-4431-A1B2-0123456789AB");
  });

  it("knows nothing about other files", () => {
    expect(identifyBuffer(Buffer.from("just text, not a binary"))).toEqual({
      format: "unknown",
      id: null,
    });
  });
});

describe("stage, verify and check", () => {
  let tmp;
  const scratch = () => {
    tmp = mkdtempSync(path.join(tmpdir(), "debug-symbols-"));
    return tmp;
  };
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("stages a .dSYM, records it, and the check accepts the binary", () => {
    const dir = scratch();
    const bin = path.join(dir, "termihub-agent");
    writeFileSync(bin, macho());
    const dwarf = path.join(`${bin}.dSYM`, "Contents", "Resources", "DWARF");
    mkdirSync(dwarf, { recursive: true });
    writeFileSync(path.join(dwarf, "termihub_agent-0123"), macho());
    const out = path.join(dir, "out");
    const { id } = stage(bin, { outDir: out, version: "1.2.3", commit: "abc1234" });
    expect(id).toBe("4C4C44A3-5555-3144-A1B2-0123456789AB");
    expect(identify(path.join(out, "termihub-agent.dSYM")).id).toBe(id);
    expect(checkDir(out, { "termihub-agent": bin })).toEqual([]);
  });

  it("stages the PDB a PE names and rejects a binary from another build", () => {
    const dir = scratch();
    const exe = path.join(dir, "termihub.exe");
    writeFileSync(exe, pe({ age: 2 }));
    writeFileSync(path.join(dir, "termihub.pdb"), pdb({ age: 2 }));
    const out = path.join(dir, "out");
    stage(exe, { outDir: out });
    const [entry] = parseManifest(readFileSync(path.join(out, MANIFEST), "utf8"));
    expect(entry).toEqual({
      name: "termihub",
      symbols: "termihub.pdb",
      format: "pe",
      id: "A3444C4C-5555-4431-A1B2-0123456789AB/2",
    });
    const other = path.join(dir, "other.exe");
    writeFileSync(other, pe({ age: 7 }));
    expect(checkDir(out, { termihub: other })).toEqual([
      `termihub: ${other} is A3444C4C-5555-4431-A1B2-0123456789AB/7, ` +
        "symbols are for A3444C4C-5555-4431-A1B2-0123456789AB/2",
    ]);
  });

  it("refuses an ELF without DWARF and a Mach-O without a .dSYM", () => {
    const dir = scratch();
    const stripped = path.join(dir, "stripped");
    writeFileSync(stripped, elf({ debug: false }));
    expect(() => stage(stripped, { outDir: path.join(dir, "o") })).toThrow(
      /CARGO_PROFILE_RELEASE_STRIP=none/
    );
    const bare = path.join(dir, "bare");
    writeFileSync(bare, macho());
    expect(() => stage(bare, { outDir: path.join(dir, "o") })).toThrow(/SPLIT_DEBUGINFO=packed/);
  });

  it("verifyMatch names both ids on a mismatch", () => {
    const dir = scratch();
    const bin = path.join(dir, "bin");
    const dbg = path.join(dir, "bin.debug");
    writeFileSync(bin, elf({ debug: false }));
    writeFileSync(dbg, elf({ buildId: Buffer.alloc(20, 1) }));
    expect(() => verifyMatch(bin, dbg)).toThrow(/build id mismatch/);
    writeFileSync(dbg, elf());
    expect(verifyMatch(bin, dbg)).toBe(BUILD_ID.toString("hex"));
  });

  it("check flags a tampered manifest and a missing symbol file", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "a.debug"), elf());
    writeFileSync(
      path.join(dir, MANIFEST),
      "# header\na\ta.debug\telf\tdeadbeef\nb\tb.debug\telf\tcafe\n"
    );
    expect(checkDir(dir)).toEqual([
      `a: a.debug is ${BUILD_ID.toString("hex")}, manifest says deadbeef`,
      "b: b.debug missing",
    ]);
    expect(checkDir(path.join(dir, "nowhere"))).toEqual([
      `${path.join(dir, "nowhere")}: no ${MANIFEST}`,
    ]);
  });
});
