/**
 * Split debug symbols for release binaries, and prove they match (#4504).
 *
 * Release binaries ship without debug info (installers must not grow), so the
 * release workflow keeps it in a separate symbol file per binary and publishes
 * those as `termiHub-<version>-debug-symbols-*.tar.gz` assets. A symbol file is
 * useless unless it belongs to exactly the shipped binary, so every step checks
 * the identity the platform's tools match them by:
 *
 *   ELF (Linux)      GNU build-id note        `.debug` file    readelf -n
 *   Mach-O (macOS)   LC_UUID per architecture `.dSYM` bundle   dwarfdump --uuid
 *   PE (Windows)     CodeView RSDS GUID + age `.pdb` file      llvm-pdbutil
 *
 * The same ids appear on the crash report's `image:` line (core
 * `diagnostics::module_image`), which is how a field report finds its symbols.
 *
 * Usage:
 *   node scripts/internal/debug-symbols.mjs id <file|.dSYM>
 *       print the format and build id as JSON
 *   node scripts/internal/debug-symbols.mjs verify <binary> <symbols>
 *       exit 1 unless both carry the same build id
 *   node scripts/internal/debug-symbols.mjs stage --out <dir> [--name <name>]
 *         [--version <v>] [--commit <sha>] <binary>
 *       put <binary>'s symbols into <dir> and record them in <dir>/SYMBOLS.txt:
 *       ELF: split the DWARF out of <binary> IN PLACE (llvm-objcopy, else objcopy)
 *            into <name>.debug and leave a .gnu_debuglink — build it with
 *            CARGO_PROFILE_RELEASE_STRIP=none so there is DWARF to split;
 *       Mach-O: copy the <binary>.dSYM cargo emits with split-debuginfo=packed;
 *       PE: copy the .pdb its CodeView record names, from next to <binary>.
 *   node scripts/internal/debug-symbols.mjs check <dir> [<name>=<binary> ...]
 *       re-verify every SYMBOLS.txt entry of an unpacked symbol archive against
 *       its symbol file, and each named binary against its entry.
 * Exit status: 0 = ok, 1 = missing or mismatched symbols, 2 = usage.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isMainModule } from "./is-main-module.mjs";

/** The manifest every symbol directory / archive carries. */
export const MANIFEST = "SYMBOLS.txt";

const hex = (buf) => Buffer.from(buf).toString("hex");

/** A Mach-O / Windows GUID as `8-4-4-4-12` uppercase. */
function uuidString(bytes) {
  const h = hex(bytes).toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A Windows GUID: Data1..Data3 are little-endian on disk. */
export function pdbGuidString(g) {
  const b = Buffer.from(g);
  const d1 = b.readUInt32LE(0).toString(16).padStart(8, "0");
  const d2 = b.readUInt16LE(4).toString(16).padStart(4, "0");
  const d3 = b.readUInt16LE(6).toString(16).padStart(4, "0");
  return `${d1}-${d2}-${d3}-${hex(b.subarray(8, 10))}-${hex(b.subarray(10, 16))}`.toUpperCase();
}

// ---------------------------------------------------------------- ELF -----

/** Parse an ELF file's section headers: [{ name, type, offset, size }]. */
function elfSections(buf) {
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const addr = (o) =>
    is64 ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)) : u32(o);
  const shoff = addr(is64 ? 0x28 : 0x20);
  const shentsize = u16(is64 ? 0x3a : 0x2e);
  const shnum = u16(is64 ? 0x3c : 0x30);
  const shstrndx = u16(is64 ? 0x3e : 0x32);
  const raw = [];
  for (let i = 0; i < shnum; i += 1) {
    const at = shoff + i * shentsize;
    raw.push({
      nameOff: u32(at),
      type: u32(at + 4),
      offset: addr(at + (is64 ? 0x18 : 0x10)),
      size: addr(at + (is64 ? 0x20 : 0x14)),
      align: addr(at + (is64 ? 0x30 : 0x20)),
    });
  }
  const strtab = raw[shstrndx];
  const name = (off) => {
    const start = strtab.offset + off;
    return buf.toString("latin1", start, buf.indexOf(0, start));
  };
  return { le, sections: raw.map((s) => ({ ...s, name: strtab ? name(s.nameOff) : "" })) };
}

const SHT_NOTE = 7;
const SHT_NOBITS = 8;
const NT_GNU_BUILD_ID = 3;

/** The GNU build-id in an ELF note section, or null. */
function noteBuildId(buf, { offset, size, align }, le) {
  const a = Number(align) === 8 ? 8 : 4;
  const pad = (n) => (n + a - 1) & ~(a - 1);
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  let off = 0;
  while (off + 12 <= size) {
    const namesz = u32(offset + off);
    const descsz = u32(offset + off + 4);
    const type = u32(offset + off + 8);
    const nameAt = off + 12;
    const descAt = pad(nameAt + namesz);
    const name = buf.toString("latin1", offset + nameAt, offset + nameAt + namesz);
    if (type === NT_GNU_BUILD_ID && name === "GNU\0") {
      return hex(buf.subarray(offset + descAt, offset + descAt + descsz));
    }
    off = pad(descAt + descsz);
  }
  return null;
}

function elfId(buf) {
  const { le, sections } = elfSections(buf);
  const notes = sections.filter((s) => s.type === SHT_NOTE && s.size > 0);
  const buildId = notes.map((s) => noteBuildId(buf, s, le)).find(Boolean) ?? null;
  const hasDwarf = sections.some(
    (s) => /^\.(z?debug_(info|line))$/.test(s.name) && s.type !== SHT_NOBITS && s.size > 0
  );
  return { format: "elf", id: buildId, hasDwarf };
}

// ------------------------------------------------------------- Mach-O -----

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_UUID = 0x1b;

function machoUuid(buf, base = 0) {
  if (buf.readUInt32LE(base) !== MH_MAGIC_64) return null;
  const ncmds = buf.readUInt32LE(base + 16);
  let off = base + 32;
  for (let i = 0; i < ncmds; i += 1) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === LC_UUID) return uuidString(buf.subarray(off + 8, off + 24));
    if (size < 8) return null;
    off += size;
  }
  return null;
}

/** Every architecture's UUID, sorted (a universal binary has several). */
function machoId(buf) {
  let uuids = [];
  if (buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    for (let i = 0; i < n; i += 1) uuids.push(machoUuid(buf, buf.readUInt32BE(8 + i * 20 + 8)));
  } else {
    uuids.push(machoUuid(buf));
  }
  uuids = uuids.filter(Boolean).sort();
  return { format: "macho", id: uuids.length ? uuids.join(",") : null };
}

/** The DWARF companion files inside a `.dSYM` bundle. */
function dsymFiles(dir) {
  const dwarf = path.join(dir, "Contents", "Resources", "DWARF");
  return existsSync(dwarf) ? readdirSync(dwarf).map((f) => path.join(dwarf, f)) : [];
}

// ----------------------------------------------------------------- PE -----

/** `{ guid, age, pdb }` from a PE file's CodeView RSDS record, or null. */
export function peCodeView(buf) {
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") return null;
  const coff = pe + 4;
  const nsections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const debugRva = buf.readUInt32LE(dirs + 6 * 8);
  const debugSize = buf.readUInt32LE(dirs + 6 * 8 + 4);
  const sectionAt = opt + optSize;
  let debugOff = -1;
  for (let i = 0; i < nsections; i += 1) {
    const s = sectionAt + i * 40;
    const va = buf.readUInt32LE(s + 12);
    const vsize = Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16));
    if (debugRva >= va && debugRva < va + vsize) {
      debugOff = buf.readUInt32LE(s + 20) + (debugRva - va);
    }
  }
  if (debugOff < 0) return null;
  for (let e = debugOff; e + 28 <= debugOff + debugSize; e += 28) {
    if (buf.readUInt32LE(e + 12) !== 2) continue; // IMAGE_DEBUG_TYPE_CODEVIEW
    const at = buf.readUInt32LE(e + 24); // PointerToRawData
    if (buf.toString("latin1", at, at + 4) !== "RSDS") return null;
    const guid = buf.subarray(at + 4, at + 20);
    const age = buf.readUInt32LE(at + 20);
    const pdb = buf.toString("utf8", at + 24, buf.indexOf(0, at + 24));
    return { guid: pdbGuidString(guid), age, pdb };
  }
  return null;
}

const MSF_MAGIC = "Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0";

/** The bytes of stream `index` of an MSF (PDB) file. */
function msfStream(buf, index) {
  const blockSize = buf.readUInt32LE(32);
  const dirBytes = buf.readUInt32LE(44);
  const dirMap = buf.readUInt32LE(52) * blockSize;
  const blocks = (n) => Math.ceil(n / blockSize);
  const dir = Buffer.concat(
    Array.from({ length: blocks(dirBytes) }, (_, i) => {
      const b = buf.readUInt32LE(dirMap + i * 4) * blockSize;
      return buf.subarray(b, b + blockSize);
    })
  ).subarray(0, dirBytes);
  const count = dir.readUInt32LE(0);
  if (index >= count) return null;
  const sizes = Array.from({ length: count }, (_, i) => dir.readUInt32LE(4 + i * 4));
  const real = (s) => (s === 0xffffffff ? 0 : s);
  let at = 4 + count * 4;
  for (let i = 0; i < index; i += 1) at += blocks(real(sizes[i])) * 4;
  const size = real(sizes[index]);
  return Buffer.concat(
    Array.from({ length: blocks(size) }, (_, i) => {
      const b = dir.readUInt32LE(at + i * 4) * blockSize;
      return buf.subarray(b, b + blockSize);
    })
  ).subarray(0, size);
}

/** `{ guid, age }` of a PDB: the info stream's GUID, the DBI stream's age. */
export function pdbInfo(buf) {
  const info = msfStream(buf, 1);
  if (!info || info.length < 28) return null;
  const dbi = msfStream(buf, 3);
  const age = dbi && dbi.length >= 12 ? dbi.readUInt32LE(8) : info.readUInt32LE(8);
  return { guid: pdbGuidString(info.subarray(12, 28)), age };
}

// ------------------------------------------------------------- common -----

/**
 * The build identity of a binary or symbol file.
 * @param {string} file - an executable, a `.debug`, a `.pdb` or a `.dSYM` dir.
 * @returns {{format: string, id: string|null, hasDwarf?: boolean, pdb?: string}}
 */
export function identify(file) {
  if (statSync(file).isDirectory()) {
    const ids = dsymFiles(file).map((f) => machoId(readFileSync(f)).id);
    return { format: "macho", id: ids.find(Boolean) ?? null };
  }
  return identifyBuffer(readFileSync(file));
}

/** {@link identify} for bytes already in memory. */
export function identifyBuffer(buf) {
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "\x7fELF") return elfId(buf);
  if (buf.length >= 4 && [MH_MAGIC_64].includes(buf.readUInt32LE(0))) return machoId(buf);
  if (buf.length >= 8 && buf.readUInt32BE(0) === FAT_MAGIC) return machoId(buf);
  if (buf.length >= 0x40 && buf.toString("latin1", 0, 2) === "MZ") {
    const cv = peCodeView(buf);
    return { format: "pe", id: cv ? `${cv.guid}/${cv.age}` : null, pdb: cv?.pdb };
  }
  if (buf.length >= 56 && buf.toString("latin1", 0, 32) === MSF_MAGIC) {
    const info = pdbInfo(buf);
    return { format: "pdb", id: info ? `${info.guid}/${info.age}` : null };
  }
  return { format: "unknown", id: null };
}

/** Throw unless `binary` and `symbols` carry the same, present build id. */
export function verifyMatch(binary, symbols) {
  const b = identify(binary);
  const s = identify(symbols);
  if (!b.id) throw new Error(`${binary}: no build id (${b.format})`);
  if (!s.id) throw new Error(`${symbols}: no build id (${s.format})`);
  if (b.id !== s.id) {
    throw new Error(`build id mismatch: ${binary} is ${b.id}, ${symbols} is ${s.id}`);
  }
  return b.id;
}

/** Parse a SYMBOLS.txt manifest into entries. */
export function parseManifest(text) {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const [name, symbols, format, id] = l.split("\t");
      return { name, symbols, format, id };
    });
}

function llvmTool(name) {
  try {
    const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
    const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
    const exe = process.platform === "win32" ? `${name}.exe` : name;
    const tool = path.join(sysroot, "lib", "rustlib", host ?? "", "bin", exe);
    if (existsSync(tool)) return tool;
  } catch {
    // no rustc on PATH: fall through
  }
  return null;
}

/** llvm-objcopy from the rustup `llvm-tools` component, else binutils objcopy. */
export function objcopy() {
  return llvmTool("llvm-objcopy") ?? "objcopy";
}

/**
 * Put `binary`'s symbols into `outDir` and record them in its manifest.
 * @returns {{symbols: string, id: string}}
 */
export function stage(binary, { outDir, name, version, commit }) {
  mkdirSync(outDir, { recursive: true });
  const base = name ?? path.basename(binary).replace(/\.exe$/i, "");
  const info = identify(binary);
  let symbols;
  if (info.format === "elf") {
    if (!info.hasDwarf) {
      throw new Error(
        `${binary} has no DWARF to split; build it with CARGO_PROFILE_RELEASE_STRIP=none`
      );
    }
    symbols = path.join(outDir, `${base}.debug`);
    const tool = objcopy();
    execFileSync(tool, ["--only-keep-debug", "--compress-debug-sections=zlib", binary, symbols]);
    execFileSync(tool, ["--strip-debug", `--add-gnu-debuglink=${symbols}`, binary]);
    if (!identify(symbols).hasDwarf) throw new Error(`${symbols} has no DWARF`);
    if (identify(binary).hasDwarf) throw new Error(`${binary} still carries DWARF`);
  } else if (info.format === "macho") {
    const dsym = `${binary}.dSYM`;
    if (!existsSync(dsym)) {
      throw new Error(`${dsym} not found; build with CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=packed`);
    }
    symbols = path.join(outDir, `${base}.dSYM`);
    cpSync(dsym, symbols, { recursive: true, dereference: true });
  } else if (info.format === "pe") {
    if (!info.pdb)
      throw new Error(`${binary} names no PDB; build with CARGO_PROFILE_RELEASE_STRIP=none`);
    const pdbName = path.win32.basename(info.pdb);
    const pdb = path.join(path.dirname(binary), pdbName);
    if (!existsSync(pdb)) throw new Error(`${pdb} not found next to ${binary}`);
    symbols = path.join(outDir, pdbName);
    cpSync(pdb, symbols);
  } else {
    throw new Error(`${binary}: not an ELF, Mach-O or PE binary`);
  }
  const id = verifyMatch(binary, symbols);
  const manifest = path.join(outDir, MANIFEST);
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      `# termiHub ${version ?? "unknown"} (${commit ?? "unknown"}) debug symbols, see\n` +
        "# docs/contributing.md -> Symbolizing a crash report.\n" +
        "# binary\tsymbols\tformat\tbuild id\n"
    );
  }
  appendFileSync(manifest, `${base}\t${path.basename(symbols)}\t${info.format}\t${id}\n`);
  return { symbols, id };
}

/**
 * Re-verify an unpacked symbol directory: every manifest entry against its
 * symbol file, and each `bins[name]` binary against its entry.
 * @returns {string[]} the problems found (empty = ok).
 */
export function checkDir(dir, bins = {}) {
  const manifest = path.join(dir, MANIFEST);
  if (!existsSync(manifest)) return [`${dir}: no ${MANIFEST}`];
  const entries = parseManifest(readFileSync(manifest, "utf8"));
  const problems = entries.length ? [] : [`${dir}: ${MANIFEST} lists no symbols`];
  for (const e of entries) {
    const file = path.join(dir, e.symbols);
    if (!existsSync(file)) {
      problems.push(`${e.name}: ${e.symbols} missing`);
      continue;
    }
    const got = identify(file).id;
    if (got !== e.id) problems.push(`${e.name}: ${e.symbols} is ${got}, manifest says ${e.id}`);
  }
  for (const [name, binary] of Object.entries(bins)) {
    const e = entries.find((x) => x.name === name);
    if (!e) {
      problems.push(`${name}: not in ${MANIFEST}`);
      continue;
    }
    const got = identify(binary).id;
    if (got !== e.id) problems.push(`${name}: ${binary} is ${got}, symbols are for ${e.id}`);
  }
  return problems;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const usage = () => {
    console.error(
      "usage: debug-symbols.mjs id <file> | verify <binary> <symbols> | " +
        "stage --out <dir> [--name n] [--version v] [--commit c] <binary> | " +
        "check <dir> [<name>=<binary> ...]"
    );
    return 2;
  };
  if (cmd === "id" && rest.length === 1) {
    console.log(JSON.stringify(identify(rest[0])));
    return 0;
  }
  if (cmd === "verify" && rest.length === 2) {
    console.log(`OK ${verifyMatch(rest[0], rest[1])}  ${rest[0]} <-> ${rest[1]}`);
    return 0;
  }
  if (cmd === "stage") {
    const opts = {};
    const args = [...rest];
    const files = [];
    while (args.length) {
      const a = args.shift();
      if (a === "--out") opts.outDir = args.shift();
      else if (a === "--name") opts.name = args.shift();
      else if (a === "--version") opts.version = args.shift();
      else if (a === "--commit") opts.commit = args.shift();
      else files.push(a);
    }
    if (!opts.outDir || files.length !== 1) return usage();
    const { symbols, id } = stage(files[0], opts);
    console.log(`staged ${symbols} (${id})`);
    return 0;
  }
  if (cmd === "check" && rest.length >= 1) {
    const bins = Object.fromEntries(
      rest.slice(1).map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      })
    );
    const problems = checkDir(rest[0], bins);
    for (const p of problems) console.error(`::error::${p}`);
    if (problems.length) return 1;
    const n = parseManifest(readFileSync(path.join(rest[0], MANIFEST), "utf8")).length;
    console.log(`OK ${rest[0]}: ${n} symbol file(s) match`);
    return 0;
  }
  return usage();
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exitCode = 1;
  }
}
