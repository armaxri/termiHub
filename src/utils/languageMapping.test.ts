import { describe, it, expect } from "vitest";
import {
  resolveLanguage,
  fileExtension,
  BUILT_IN_FILENAME_MAPPINGS,
  BUILT_IN_EXTENSION_MAPPINGS,
} from "./languageMapping";

describe("fileExtension", () => {
  it("returns extension including dot for regular files", () => {
    expect(fileExtension("foo.ts")).toBe(".ts");
    expect(fileExtension("index.html")).toBe(".html");
    expect(fileExtension("archive.tar.gz")).toBe(".gz");
  });

  it("returns undefined for dotfiles (no further extension)", () => {
    expect(fileExtension(".gitignore")).toBeUndefined();
    expect(fileExtension(".env")).toBeUndefined();
    expect(fileExtension(".bashrc")).toBeUndefined();
  });

  it("returns undefined for files without any extension", () => {
    expect(fileExtension("Makefile")).toBeUndefined();
    expect(fileExtension("Dockerfile")).toBeUndefined();
    expect(fileExtension("README")).toBeUndefined();
  });
});

describe("resolveLanguage — built-in filename mappings", () => {
  it("maps Dockerfile to dockerfile", () => {
    expect(resolveLanguage("Dockerfile")).toBe("dockerfile");
  });

  it("maps Containerfile to dockerfile", () => {
    expect(resolveLanguage("Containerfile")).toBe("dockerfile");
  });

  it("maps Makefile to makefile", () => {
    expect(resolveLanguage("Makefile")).toBe("makefile");
  });

  it("maps Jenkinsfile to java", () => {
    expect(resolveLanguage("Jenkinsfile")).toBe("java");
  });

  it("maps CMakeLists.txt to cmake", () => {
    expect(resolveLanguage("CMakeLists.txt")).toBe("cmake");
  });

  it("maps cmakelists.txt (lowercase) to cmake — case-insensitive", () => {
    expect(resolveLanguage("cmakelists.txt")).toBe("cmake");
  });

  it("maps dockerfile (lowercase) to dockerfile — case-insensitive", () => {
    expect(resolveLanguage("dockerfile")).toBe("dockerfile");
  });

  it("maps Vagrantfile to ruby", () => {
    expect(resolveLanguage("Vagrantfile")).toBe("ruby");
  });

  it("maps Gemfile to ruby", () => {
    expect(resolveLanguage("Gemfile")).toBe("ruby");
  });

  it("maps .gitignore to plaintext", () => {
    expect(resolveLanguage(".gitignore")).toBe("plaintext");
  });

  it("maps .gitattributes to ini", () => {
    expect(resolveLanguage(".gitattributes")).toBe("ini");
  });

  it("maps .editorconfig to ini", () => {
    expect(resolveLanguage(".editorconfig")).toBe("ini");
  });

  it("maps .env to shell", () => {
    expect(resolveLanguage(".env")).toBe("shell");
  });

  it("maps .env.local to shell", () => {
    expect(resolveLanguage(".env.local")).toBe("shell");
  });

  it("maps .eslintrc to json", () => {
    expect(resolveLanguage(".eslintrc")).toBe("json");
  });

  it("maps .bashrc to shell", () => {
    expect(resolveLanguage(".bashrc")).toBe("shell");
  });

  it("maps .clang-format to yaml", () => {
    expect(resolveLanguage(".clang-format")).toBe("yaml");
  });
});

describe("resolveLanguage — built-in extension mappings", () => {
  it("maps .conf to ini", () => {
    expect(resolveLanguage("nginx.conf")).toBe("ini");
  });

  it("maps .cfg to ini", () => {
    expect(resolveLanguage("app.cfg")).toBe("ini");
  });

  it("maps .fish to shell", () => {
    expect(resolveLanguage("aliases.fish")).toBe("shell");
  });

  it("maps .zsh to shell", () => {
    expect(resolveLanguage("setup.zsh")).toBe("shell");
  });

  it("maps .plist to xml", () => {
    expect(resolveLanguage("Info.plist")).toBe("xml");
  });

  it("maps .mk to makefile", () => {
    expect(resolveLanguage("common.mk")).toBe("makefile");
  });

  it("maps .tfvars to hcl", () => {
    expect(resolveLanguage("production.tfvars")).toBe("hcl");
  });

  it("maps .glsl to cpp", () => {
    expect(resolveLanguage("shader.glsl")).toBe("cpp");
  });

  it("maps .lock to yaml", () => {
    expect(resolveLanguage("yarn.lock")).toBe("yaml");
  });

  it("maps .ipynb to json", () => {
    expect(resolveLanguage("notebook.ipynb")).toBe("json");
  });
});

describe("resolveLanguage — returns undefined for unrecognised files", () => {
  it("returns undefined for .ts (Monaco handles it)", () => {
    expect(resolveLanguage("app.ts")).toBeUndefined();
  });

  it("returns undefined for .py (Monaco handles it)", () => {
    expect(resolveLanguage("script.py")).toBeUndefined();
  });

  it("returns undefined for unknown extension", () => {
    expect(resolveLanguage("file.xyz123")).toBeUndefined();
  });
});

describe("resolveLanguage — user overrides take precedence", () => {
  it("user override beats built-in filename mapping", () => {
    expect(resolveLanguage("Jenkinsfile", { Jenkinsfile: "groovy" })).toBe("groovy");
  });

  it("user override beats built-in extension mapping", () => {
    expect(resolveLanguage("nginx.conf", { ".conf": "nginx" })).toBe("nginx");
  });

  it("user exact-filename override beats user extension override", () => {
    expect(resolveLanguage("Makefile", { Makefile: "plaintext", ".mk": "ini" })).toBe("plaintext");
  });

  it("user extension override applies to any file with that extension", () => {
    expect(resolveLanguage("foo.xyz", { ".xyz": "python" })).toBe("python");
    expect(resolveLanguage("bar.xyz", { ".xyz": "python" })).toBe("python");
  });

  it("empty overrides object does not affect built-in behaviour", () => {
    expect(resolveLanguage("Dockerfile", {})).toBe("dockerfile");
  });
});

describe("BUILT_IN_FILENAME_MAPPINGS and BUILT_IN_EXTENSION_MAPPINGS sanity checks", () => {
  it("all language IDs are non-empty strings", () => {
    for (const [pattern, lang] of Object.entries(BUILT_IN_FILENAME_MAPPINGS)) {
      expect(typeof lang, `filename mapping for ${pattern}`).toBe("string");
      expect(lang.length, `filename mapping for ${pattern} is empty`).toBeGreaterThan(0);
    }
    for (const [pattern, lang] of Object.entries(BUILT_IN_EXTENSION_MAPPINGS)) {
      expect(typeof lang, `extension mapping for ${pattern}`).toBe("string");
      expect(lang.length, `extension mapping for ${pattern} is empty`).toBeGreaterThan(0);
    }
  });

  it("all extension keys start with a dot", () => {
    for (const ext of Object.keys(BUILT_IN_EXTENSION_MAPPINGS)) {
      expect(ext.startsWith("."), `${ext} should start with a dot`).toBe(true);
    }
  });
});
