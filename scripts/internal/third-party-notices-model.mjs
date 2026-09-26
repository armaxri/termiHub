// Pure, I/O-free model behind scripts/internal/third-party-notices.mjs
// (PKG-009): SPDX allowlist evaluation, license-text normalization and the
// NoticesBuilder that merges cargo-about reports, npm packages and external
// texts into one deduplicated plain-text THIRD_PARTY_NOTICES.txt.
//
// Unit-tested by third-party-notices.test.mjs.
/**
 * Tokenize and evaluate an SPDX license expression against an allowlist.
 * `OR` needs any arm allowed, `AND` needs every arm; `A WITH B` must be allowed
 * as the literal "A WITH B" (or A itself, since an exception only adds rights).
 *
 * @param {string} expression - SPDX expression, e.g. "(MIT OR Apache-2.0)".
 * @param {Set<string>} allowed - allowlisted SPDX ids / "A WITH B" terms.
 * @returns {boolean} whether the expression can be satisfied by allowed terms.
 */
export function spdxAllowed(expression, allowed) {
  if (typeof expression !== "string" || expression.trim() === "") return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parseAtom = () => {
    const tok = next();
    if (tok === undefined) throw new Error("unexpected end");
    if (tok === "(") {
      const value = parseOr();
      if (next() !== ")") throw new Error("missing )");
      return value;
    }
    if (tok === ")" || /^(AND|OR|WITH)$/i.test(tok)) throw new Error(`unexpected ${tok}`);
    if (peek() && peek().toUpperCase() === "WITH") {
      next();
      const exception = next();
      if (exception === undefined) throw new Error("missing exception");
      return allowed.has(`${tok} WITH ${exception}`) || allowed.has(tok);
    }
    return allowed.has(tok);
  };
  const parseAnd = () => {
    let value = parseAtom();
    while (peek() && peek().toUpperCase() === "AND") {
      next();
      value = parseAtom() && value;
    }
    return value;
  };
  function parseOr() {
    let value = parseAnd();
    while (peek() && peek().toUpperCase() === "OR") {
      next();
      value = parseAnd() || value;
    }
    return value;
  }

  try {
    const value = parseOr();
    return pos === tokens.length && value;
  } catch {
    return false;
  }
}

/**
 * Normalize a license text for deduplication and stable output: LF line endings,
 * no trailing whitespace, no leading/trailing blank lines.
 *
 * @param {string} text - raw license text.
 * @returns {string} the normalized text.
 */
export function normalizeText(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Stable string comparison (locale-independent, so output is deterministic). */
export const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Word-wrap a comma-separated list behind a label, continuation lines indented.
 *
 * @param {string} label - leading label, e.g. "Used by: ".
 * @param {string[]} items - list items.
 * @param {number} [width] - maximum line width.
 * @returns {string[]} the wrapped lines.
 */
export function wrapList(label, items, width = 78) {
  const lines = [];
  const indent = " ".repeat(label.length);
  let line = label;
  let empty = true;
  items.forEach((item, i) => {
    const piece = i < items.length - 1 ? `${item},` : item;
    if (empty) {
      line += piece;
    } else if (line.length + 1 + piece.length > width) {
      lines.push(line);
      line = indent + piece;
    } else {
      line += ` ${piece}`;
    }
    empty = false;
  });
  lines.push(line);
  return lines;
}

/** Display form of a license expression: no redundant outer parentheses. */
export function displayExpression(expression) {
  const trimmed = (expression ?? "").trim();
  return /^\([^()]*\)$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Builds the combined notices model from cargo-about JSON reports, npm package
 * records and external texts. Identical texts are merged into one entry.
 */
export class NoticesBuilder {
  constructor() {
    /** @type {Map<string, {ids: Set<string>, users: Set<string>, synthesized: boolean}>} */
    this.texts = new Map();
    /** @type {Map<string, {name: string, version: string, license: string, components: Set<string>, texts: Set<string>}>} */
    this.crates = new Map();
    /** @type {Map<string, {name: string, version: string, license: string, texts: Set<string>, note: string}>} */
    this.npm = new Map();
    /** Standard (synthesized) texts per SPDX id, reused for npm packages shipping no file. */
    this.standardTexts = new Map();
    /** Packages for which no license text at all could be attached. */
    this.missing = [];
  }

  addText(text, id, user, synthesized = false) {
    const key = normalizeText(text);
    if (key === "") return null;
    let entry = this.texts.get(key);
    if (!entry) {
      entry = { ids: new Set(), users: new Set(), synthesized };
      this.texts.set(key, entry);
    }
    entry.ids.add(id);
    entry.users.add(user);
    entry.synthesized = entry.synthesized && synthesized;
    return key;
  }

  /**
   * Add one cargo-about `--format json` report.
   *
   * @param {string} component - component id (desktop / agent / rdp-sidecar).
   * @param {{crates: Array<{package: {name: string, version: string}, license?: string}>,
   *          licenses: Array<{id: string, text: string, source_path?: string | null,
   *                            used_by: Array<{crate: {name: string, version: string}}>}>}} report
   */
  addCargoAbout(component, report) {
    for (const krate of report.crates ?? []) {
      const { name, version } = krate.package;
      const key = `${name} ${version}`;
      const entry = this.crates.get(key) ?? {
        name,
        version,
        license: krate.license || krate.package.license || "",
        components: new Set(),
        texts: new Set(),
      };
      entry.components.add(component);
      this.crates.set(key, entry);
    }
    for (const license of report.licenses ?? []) {
      const synthesized = license.source_path == null;
      if (synthesized && !this.standardTexts.has(license.id)) {
        this.standardTexts.set(license.id, license.text);
      }
      for (const use of license.used_by ?? []) {
        const key = `${use.crate.name} ${use.crate.version}`;
        const textKey = this.addText(license.text, license.id, key, synthesized);
        if (textKey === null) continue;
        const entry = this.crates.get(key);
        if (entry) entry.texts.add(textKey);
      }
    }
  }

  /**
   * Add one npm package.
   *
   * @param {{name: string, version: string, license: string, author?: string,
   *          files: Array<{name: string, text: string}>}} pkg - package with its license files.
   */
  addNpm(pkg) {
    const key = `${pkg.name} ${pkg.version}`;
    const entry = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      texts: new Set(),
      note: "",
    };
    for (const file of pkg.files) {
      const textKey = this.addText(file.text, displayExpression(pkg.license), key);
      if (textKey !== null) entry.texts.add(textKey);
    }
    this.npm.set(key, entry);
  }

  /**
   * Attach standard license texts to npm packages that ship no license file.
   * Must run after every cargo-about report was added (it supplies the texts).
   */
  resolveMissingNpmTexts() {
    for (const [key, entry] of this.npm) {
      if (entry.texts.size > 0) continue;
      const ids = (entry.license.match(/[^\s()]+/g) ?? []).filter(
        (t) => !/^(AND|OR|WITH)$/i.test(t)
      );
      const standard = ids.map((id) => [id, this.standardTexts.get(id)]).find(([, text]) => text);
      if (standard) {
        entry.texts.add(this.addText(standard[1], standard[0], key, true));
        entry.note = "no license file in package; standard license text";
      } else {
        entry.note = "no license file in package";
        this.missing.push(`npm ${key} (${entry.license})`);
      }
    }
    for (const [key, entry] of this.crates) {
      if (entry.texts.size === 0) this.missing.push(`crate ${key} (${entry.license})`);
    }
  }

  /**
   * Render the combined plain-text notices file.
   *
   * @param {{version: string, externalNotice: string}} opts - app version and the
   *   THIRD_PARTY_LICENSES.md body for the external-programs section.
   * @returns {string} the notices file contents.
   */
  render({ version, externalNotice }) {
    const ordered = [...this.texts.entries()].sort(([ta, a], [tb, b]) => {
      const ia = [...a.ids].sort().join(" ");
      const ib = [...b.ids].sort().join(" ");
      return (
        compareStrings(ia, ib) ||
        compareStrings([...a.users].sort()[0], [...b.users].sort()[0]) ||
        compareStrings(ta, tb)
      );
    });
    const number = new Map(ordered.map(([text], i) => [text, i + 1]));
    const refs = (texts) =>
      [...texts]
        .map((t) => number.get(t))
        .sort((a, b) => a - b)
        .map((n) => `[L${n}]`)
        .join(" ");
    const sortEntries = (map) =>
      [...map.values()].sort(
        (a, b) => compareStrings(a.name, b.name) || compareStrings(a.version, b.version)
      );

    const rule = "=".repeat(78);
    const out = [];
    out.push("termiHub - Third-Party Notices", rule, "");
    out.push(
      `termiHub ${version} is licensed under the MIT License (see LICENSE). It is built from`,
      "and redistributes the third-party open-source software listed below. This file",
      "reproduces their license terms and copyright notices as required by those licenses.",
      "",
      "Generated by scripts/internal/third-party-notices.mjs from Cargo.lock,",
      "rdp-sidecar/Cargo.lock and pnpm-lock.yaml - do not edit by hand.",
      "",
      "Contents",
      `  1. Rust crates (${this.crates.size}) - desktop app, agent, RDP sidecar`,
      `  2. npm packages (${this.npm.size}) - desktop app frontend`,
      "  3. External programs (not bundled)",
      `  4. License texts (${ordered.length})`,
      ""
    );

    out.push(rule, "1. RUST CRATES", rule, "");
    out.push("Name Version - License - Used by - License text(s)", "");
    for (const c of sortEntries(this.crates)) {
      const used = [...c.components].sort().join(", ");
      out.push(
        `${c.name} ${c.version} - ${c.license || "see text"} - ${used} - ${refs(c.texts) || "(none)"}`
      );
    }
    out.push("");

    out.push(rule, "2. NPM PACKAGES", rule, "");
    out.push("Name Version - License - License text(s)", "");
    for (const p of sortEntries(this.npm)) {
      const note = p.note ? ` (${p.note})` : "";
      out.push(
        `${p.name} ${p.version} - ${displayExpression(p.license)} - ${refs(p.texts) || "(none)"}${note}`
      );
    }
    out.push("");

    out.push(rule, "3. EXTERNAL PROGRAMS (NOT BUNDLED)", rule, "");
    out.push(normalizeText(externalNotice), "");

    out.push(rule, "4. LICENSE TEXTS", rule, "");
    for (const [text, entry] of ordered) {
      const n = number.get(text);
      const users = [...entry.users].sort();
      out.push("-".repeat(78));
      out.push(`[L${n}] ${[...entry.ids].sort().join(", ")}`);
      if (entry.synthesized)
        out.push("(standard license text - the package ships no license file)");
      out.push(...wrapList("Used by: ", users));
      out.push("-".repeat(78), "", text, "");
    }
    return `${out.join("\n").replace(/\n+$/, "")}\n`;
  }
}
