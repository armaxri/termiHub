import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  aptCalls,
  checkDockerfile,
  checkMirrorFallback,
  checkShell,
  checkYaml,
  findProblems,
  kindOf,
  loadFiles,
  logicalLines,
} from "./check-apt-retries.mjs";

const CONF =
  "RUN printf 'Acquire::Retries \"5\";\\n' \\\n    > /etc/apt/apt.conf.d/80-ci-retries\n";

describe("logicalLines", () => {
  it("joins backslash continuations and keeps the start line", () => {
    expect(logicalLines("a \\\n  b\nc")).toEqual([
      { line: 1, text: "a    b" },
      { line: 3, text: "c" },
    ]);
  });
});

describe("aptCalls", () => {
  it("finds downloading sub-commands, with and without sudo", () => {
    expect(aptCalls("sudo apt-get update && apt-get install -y x")).toEqual([
      { verb: "update", sudo: true, retries: false },
      { verb: "install", sudo: false, retries: false },
    ]);
    expect(aptCalls("sudo apt install socat")).toEqual([
      { verb: "install", sudo: true, retries: false },
    ]);
  });

  it("sees the inline retry flag and skips option values", () => {
    expect(aptCalls("apt-get -o Acquire::Retries=5 -q update")).toEqual([
      { verb: "update", sudo: false, retries: true },
    ]);
  });

  it("ignores non-downloading commands, comments, hints and apt.conf paths", () => {
    expect(aptCalls("apt-get clean")).toEqual([]);
    expect(aptCalls("# apt-get install foo")).toEqual([]);
    expect(aptCalls('echo "install with: sudo apt install socat"')).toEqual([]);
    expect(aptCalls("cat /etc/apt/apt.conf.d/80-ci-retries")).toEqual([]);
    expect(aptCalls('die "no fish (apt-get install fish)" # apt-retries: ignore')).toEqual([]);
  });
});

describe("checkDockerfile", () => {
  it("passes when the conf file is written earlier in the stage", () => {
    expect(checkDockerfile("D", `FROM ubuntu\n${CONF}RUN apt-get update`)).toEqual([]);
  });

  it("fails an apt call before the conf file, or in a fresh stage", () => {
    expect(checkDockerfile("D", `FROM ubuntu\nRUN apt-get update\n${CONF}`)).toHaveLength(1);
    const twoStages = `FROM ubuntu AS a\n${CONF}FROM debian\nRUN apt-get install -y x`;
    expect(checkDockerfile("D", twoStages)).toEqual([
      expect.stringMatching(/^D:5: apt-get install without retries/),
    ]);
  });

  it("inherits the conf file through FROM <earlier stage>", () => {
    const text = `FROM ubuntu AS base\n${CONF}FROM base AS next\nRUN apt-get update`;
    expect(checkDockerfile("D", text)).toEqual([]);
  });
});

describe("checkYaml", () => {
  const job = (steps) => `on: push\njobs:\n  build:\n    steps:\n${steps}\n`;

  it("needs the apt-retries action before a host sudo apt call in the same job", () => {
    const ok = job("      - uses: ./.github/actions/apt-retries\n      - run: sudo apt-get update");
    expect(checkYaml("w.yml", ok, true)).toEqual([]);
    const missing = job("      - run: sudo apt-get update");
    expect(checkYaml("w.yml", missing, true)).toHaveLength(1);
  });

  it("treats step names as prose", () => {
    expect(checkYaml("w.yml", job("      - name: Check apt download retries"), true)).toEqual([]);
  });

  it("does not carry the action across jobs", () => {
    const text =
      "jobs:\n  a:\n    steps:\n      - uses: ./.github/actions/apt-retries\n" +
      "  b:\n    steps:\n      - run: sudo apt-get update\n";
    expect(checkYaml("w.yml", text, true)).toEqual([
      expect.stringMatching(/^w\.yml:7: sudo apt-get update/),
    ]);
  });

  it("requires the inline flag for in-container (no sudo) calls", () => {
    const text = job(
      "      - uses: ./.github/actions/apt-retries\n" +
        "      - run: |\n          docker run img bash -c '\n            apt-get update -qq\n'"
    );
    expect(checkYaml("w.yml", text, true)).toHaveLength(1);
    const fixed = text.replace("apt-get update", "apt-get -o Acquire::Retries=5 update");
    expect(checkYaml("w.yml", fixed, true)).toEqual([]);
  });
});

describe("checkShell", () => {
  it("needs the inline flag or an earlier conf write", () => {
    expect(checkShell("s.sh", "sudo apt-get update")).toHaveLength(1);
    expect(checkShell("s.sh", "sudo apt-get -o Acquire::Retries=5 update")).toEqual([]);
    const conf =
      "echo 'Acquire::Retries \"5\";' | sudo tee /etc/apt/apt.conf.d/80-ci-retries\n" +
      "sudo apt-get update";
    expect(checkShell("s.sh", conf)).toEqual([]);
  });
});

describe("kindOf / findProblems", () => {
  it("classifies only the files it checks", () => {
    expect(kindOf(".github/workflows/ci.yml")).toBe("workflow");
    expect(kindOf(".github/actions/x/action.yml")).toBe("action");
    expect(kindOf("tests/docker/a/Dockerfile")).toBe("dockerfile");
    expect(kindOf("agent/docker/Dockerfile.x86_64-unknown-linux-musl")).toBe("dockerfile");
    expect(kindOf("scripts/x.sh")).toBe("shell");
    expect(kindOf("docs/contributing.md")).toBeNull();
  });

  it("ignores prose files and reports every kind", () => {
    const problems = findProblems({
      "docs/x.md": "sudo apt-get update",
      "a/Dockerfile": "FROM ubuntu\nRUN apt-get update",
      "s.sh": "apt-get install -y x",
    });
    expect(problems).toHaveLength(2);
  });
});

describe("checkMirrorFallback", () => {
  it("passes when the action runs the mirror fallback script", () => {
    const action =
      'runs:\n  steps:\n    - run: sudo bash "$GITHUB_ACTION_PATH/mirror-fallback.sh"\n';
    expect(checkMirrorFallback(action)).toEqual([]);
  });

  it("fails when the step is gone or only mentioned in a comment", () => {
    expect(checkMirrorFallback("runs:\n  steps: []\n")).toHaveLength(1);
    expect(
      checkMirrorFallback('# run: sudo bash "$GITHUB_ACTION_PATH/mirror-fallback.sh"\n')
    ).toHaveLength(1);
  });

  it("is applied to the apt-retries action by findProblems", () => {
    const problems = findProblems({ ".github/actions/apt-retries/action.yml": "runs: {}\n" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/mirror-fallback\.sh/);
  });
});

describe("the real repository", () => {
  it("retries every apt download", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadFiles(root))).toEqual([]);
  });
});
