import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import {
  DEFAULT_FILE,
  buildPutPayload,
  diffProtection,
  fetchProtection,
  normalizeLive,
  parseArgs,
  parseExpected,
  resolveToken,
  run,
} from "./check-branch-protection.mjs";

const CONTEXTS = ["Lint Commit Messages", "Rust Code Quality"];

/** An expectation in the committed file's shape. */
function expected(overrides = {}) {
  return {
    required_status_checks: { strict: false, app_id: 15368, contexts: [...CONTEXTS] },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
    },
    restrictions: null,
    required_signatures: false,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: false,
    lock_branch: false,
    allow_fork_syncing: false,
    ...overrides,
  };
}

/** A GET .../protection response matching expected(). */
function apiResponse(overrides = {}) {
  const on = (enabled) => ({ enabled });
  return {
    url: "https://api.github.com/repos/o/r/branches/main/protection",
    required_status_checks: {
      strict: false,
      contexts: [...CONTEXTS],
      checks: CONTEXTS.map((context) => ({ context, app_id: 15368 })),
    },
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
    },
    required_signatures: on(false),
    enforce_admins: on(true),
    required_linear_history: on(false),
    allow_force_pushes: on(false),
    allow_deletions: on(false),
    block_creations: on(false),
    required_conversation_resolution: on(false),
    lock_branch: on(false),
    allow_fork_syncing: on(false),
    ...overrides,
  };
}

/** A fetch mock answering per branch name. */
function mockFetch(byBranch) {
  return vi.fn(async (url) => {
    const branch = decodeURIComponent(url.split("/branches/")[1].split("/")[0]);
    const [status, body] = byBranch[branch];
    return { status, json: async () => body };
  });
}

describe("parseExpected", () => {
  it("accepts the committed .github/branch-protection.json", () => {
    const branches = parseExpected(readFileSync(DEFAULT_FILE, "utf8"));
    expect(Object.keys(branches)).toEqual(["main", "develop"]);
    expect(branches.main.status).toBe("enforced");
    expect(branches.develop.status).toBe("proposed");
  });

  it("never requires a matrix-leg check name on develop (it would block skipped PRs)", () => {
    const { develop } = parseExpected(readFileSync(DEFAULT_FILE, "utf8"));
    const legs = develop.protection.required_status_checks.contexts.filter((c) =>
      /^(Run Tests|Build on) /.test(c)
    );
    expect(legs).toEqual([]);
  });

  it("rejects an unknown status", () => {
    const doc = { branches: { main: { status: "maybe", protection: expected() } } };
    expect(() => parseExpected(JSON.stringify(doc))).toThrow(/status/);
  });

  it("rejects a missing toggle", () => {
    const p = expected();
    delete p.allow_force_pushes;
    const doc = { branches: { main: { status: "enforced", protection: p } } };
    expect(() => parseExpected(JSON.stringify(doc))).toThrow(/allow_force_pushes/);
  });

  it("rejects an empty branch map", () => {
    expect(() => parseExpected('{"branches":{}}')).toThrow(/non-empty/);
  });
});

describe("normalizeLive", () => {
  it("maps the API shape onto the expectation shape", () => {
    expect(normalizeLive(apiResponse())).toEqual(expected());
  });

  it("keeps null for an unprotected branch", () => {
    expect(normalizeLive(null)).toBeNull();
  });

  it("reports missing optional sections as null", () => {
    const api = apiResponse();
    delete api.required_status_checks;
    delete api.required_pull_request_reviews;
    const live = normalizeLive(api);
    expect(live.required_status_checks).toBeNull();
    expect(live.required_pull_request_reviews).toBeNull();
  });
});

describe("diffProtection", () => {
  it("is empty when live matches", () => {
    expect(diffProtection(expected(), normalizeLive(apiResponse()))).toEqual([]);
  });

  it("ignores the order of required checks", () => {
    const api = apiResponse();
    api.required_status_checks.contexts.reverse();
    expect(diffProtection(expected(), normalizeLive(api))).toEqual([]);
  });

  it("names a removed and an added required check", () => {
    const api = apiResponse();
    api.required_status_checks.contexts = ["Lint Commit Messages", "Something Else"];
    expect(diffProtection(expected(), normalizeLive(api))).toEqual([
      'required check missing live: "Rust Code Quality"',
      'required check live but not expected: "Something Else"',
    ]);
  });

  it("lists every expected check when live requires none", () => {
    const api = apiResponse();
    delete api.required_status_checks;
    expect(diffProtection(expected(), normalizeLive(api))).toEqual([
      "required status checks: live requires none",
      'required check missing live: "Lint Commit Messages"',
      'required check missing live: "Rust Code Quality"',
    ]);
  });

  it("flags relaxed toggles (force pushes, admin enforcement)", () => {
    const api = apiResponse({
      allow_force_pushes: { enabled: true },
      enforce_admins: { enabled: false },
    });
    expect(diffProtection(expected(), normalizeLive(api))).toEqual([
      "enforce_admins: expected true, live false",
      "allow_force_pushes: expected false, live true",
    ]);
  });

  it("flags strict and app_id changes", () => {
    const api = apiResponse();
    api.required_status_checks.strict = true;
    api.required_status_checks.checks = CONTEXTS.map((context) => ({ context, app_id: null }));
    expect(diffProtection(expected(), normalizeLive(api))).toEqual([
      "required status checks strict (up to date): expected false, live true",
      "required checks app_id: expected 15368, live null",
    ]);
  });

  it("flags a dropped pull-request requirement and a review-count change", () => {
    const dropped = apiResponse();
    delete dropped.required_pull_request_reviews;
    expect(diffProtection(expected(), normalizeLive(dropped))).toEqual([
      "pull request required: expected true, live false",
    ]);
    const counted = apiResponse();
    counted.required_pull_request_reviews.required_approving_review_count = 2;
    expect(diffProtection(expected(), normalizeLive(counted))).toEqual([
      "pull request reviews required_approving_review_count: expected 0, live 2",
    ]);
  });

  it("flags push restrictions that appear live", () => {
    const api = apiResponse({ restrictions: { users: [{ login: "x" }], teams: [], apps: [] } });
    expect(diffProtection(expected(), normalizeLive(api))).toEqual([
      'push restrictions: expected none, live {"users":["x"],"teams":[],"apps":[]}',
    ]);
  });

  it("reports an unprotected branch", () => {
    expect(diffProtection(expected(), null)).toEqual([
      "branch is NOT protected at all (expected protection rules)",
    ]);
  });
});

describe("buildPutPayload", () => {
  it("pins every required check to the app id and drops required_signatures", () => {
    const payload = buildPutPayload(expected());
    expect(payload.required_status_checks).toEqual({
      strict: false,
      checks: CONTEXTS.map((context) => ({ context, app_id: 15368 })),
    });
    expect(payload).not.toHaveProperty("required_signatures");
    expect(payload.enforce_admins).toBe(true);
    expect(payload.restrictions).toBeNull();
  });

  it("omits app_id when the expectation does not pin one", () => {
    const p = expected({ required_status_checks: { strict: true, contexts: ["A"] } });
    expect(buildPutPayload(p).required_status_checks).toEqual({
      strict: true,
      checks: [{ context: "A" }],
    });
  });

  it("round-trips: applying the payload yields no drift", () => {
    const committed = parseExpected(readFileSync(DEFAULT_FILE, "utf8"));
    for (const { protection } of Object.values(committed)) {
      const put = buildPutPayload(protection);
      const on = (enabled) => ({ enabled });
      const api = {
        required_status_checks: put.required_status_checks && {
          strict: put.required_status_checks.strict,
          contexts: put.required_status_checks.checks.map((c) => c.context),
          checks: put.required_status_checks.checks,
        },
        required_pull_request_reviews: put.required_pull_request_reviews,
        restrictions: put.restrictions,
        required_signatures: on(protection.required_signatures),
      };
      for (const k of Object.keys(put)) {
        if (typeof put[k] === "boolean") api[k] = on(put[k]);
      }
      expect(diffProtection(protection, normalizeLive(api))).toEqual([]);
    }
  });
});

describe("fetchProtection", () => {
  it("sends the token and returns the body", async () => {
    const fetchImpl = mockFetch({ main: [200, apiResponse()] });
    const got = await fetchProtection("o/r", "main", { token: "t0k", fetchImpl });
    expect(got.state).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/o/r/branches/main/protection");
    expect(init.headers.Authorization).toBe("Bearer t0k");
  });

  it("treats 'Branch not protected' as unprotected", async () => {
    const fetchImpl = mockFetch({ main: [404, { message: "Branch not protected" }] });
    expect(await fetchProtection("o/r", "main", { fetchImpl })).toEqual({ state: "unprotected" });
  });

  it.each([
    [403, "Resource not accessible by integration"],
    [401, "Bad credentials"],
    [404, "Not Found"],
  ])("treats HTTP %i (%s) as unreadable", async (status, message) => {
    const fetchImpl = mockFetch({ main: [status, { message }] });
    const got = await fetchProtection("o/r", "main", { fetchImpl });
    expect(got).toEqual({ state: "unreadable", message: `HTTP ${status}: ${message}` });
  });

  it("throws on a missing branch and on server errors", async () => {
    await expect(
      fetchProtection("o/r", "main", {
        fetchImpl: mockFetch({ main: [404, { message: "Branch not found" }] }),
      })
    ).rejects.toThrow(/does not exist/);
    await expect(
      fetchProtection("o/r", "main", { fetchImpl: mockFetch({ main: [500, { message: "boom" }] }) })
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("run", () => {
  const branches = {
    main: { status: "enforced", protection: expected() },
    develop: { status: "proposed", protection: expected({ enforce_admins: false }) },
  };

  it("exits 0 when nothing drifts", async () => {
    const develop = apiResponse({ enforce_admins: { enabled: false } });
    const fetchImpl = mockFetch({ main: [200, apiResponse()], develop: [200, develop] });
    const { exitCode, results } = await run({ repo: "o/r", branches, fetchImpl });
    expect(exitCode).toBe(0);
    expect(results.map((r) => r.outcome)).toEqual(["match", "match"]);
  });

  it("exits 1 when an enforced branch drifts", async () => {
    const fetchImpl = mockFetch({
      main: [200, apiResponse({ allow_deletions: { enabled: true } })],
      develop: [200, apiResponse({ enforce_admins: { enabled: false } })],
    });
    const { exitCode, report } = await run({ repo: "o/r", branches, fetchImpl });
    expect(exitCode).toBe(1);
    expect(report).toContain("DRIFT main (enforced): 1 difference(s)");
    expect(report).toContain("  - allow_deletions: expected false, live true");
  });

  it("reports but does not fail on a proposed branch that is not applied", async () => {
    const fetchImpl = mockFetch({ main: [200, apiResponse()], develop: [200, apiResponse()] });
    const { exitCode, results, report } = await run({ repo: "o/r", branches, fetchImpl });
    expect(exitCode).toBe(0);
    expect(results[1]).toEqual({ branch: "develop", status: "proposed", outcome: "pending" });
    expect(report.join("\n")).toContain("apply-branch-protection.sh --branch develop --apply");
  });

  it("skips with a notice when the token cannot read protection", async () => {
    const denied = [403, { message: "Resource not accessible by integration" }];
    const fetchImpl = mockFetch({ main: denied, develop: denied });
    const { exitCode, results, report } = await run({ repo: "o/r", branches, fetchImpl });
    expect(exitCode).toBe(0);
    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(report.join("\n")).toMatch(/BRANCH_PROTECTION_TOKEN/);
  });

  it("fails when a configured token cannot read protection", async () => {
    const fetchImpl = mockFetch({ main: [401, { message: "Bad credentials" }] });
    await expect(
      run({ repo: "o/r", branches, only: ["main"], fetchImpl, requireReadable: true })
    ).rejects.toThrow(/configured token/);
  });

  it("checks only the requested branches and rejects unknown ones", async () => {
    const fetchImpl = mockFetch({ main: [200, apiResponse()] });
    const { results } = await run({ repo: "o/r", branches, only: ["main"], fetchImpl });
    expect(results).toHaveLength(1);
    await expect(run({ repo: "o/r", branches, only: ["nope"], fetchImpl })).rejects.toThrow(
      /not in/
    );
  });
});

describe("resolveToken", () => {
  it("prefers BRANCH_PROTECTION_TOKEN over GH_TOKEN and GITHUB_TOKEN", () => {
    const exec = vi.fn();
    expect(
      resolveToken({ BRANCH_PROTECTION_TOKEN: "a", GH_TOKEN: "b", GITHUB_TOKEN: "c" }, exec)
    ).toBe("a");
    expect(resolveToken({ GITHUB_TOKEN: "c" }, exec)).toBe("c");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to gh auth token, and to empty when gh is unavailable", () => {
    expect(resolveToken({}, () => "gho_x\n")).toBe("gho_x");
    expect(
      resolveToken({}, () => {
        throw new Error("gh not found");
      })
    ).toBe("");
  });
});

describe("parseArgs", () => {
  it("collects repeated --branch and the other options", () => {
    const opts = parseArgs([
      "--repo",
      "o/r",
      "--branch",
      "main",
      "--branch",
      "develop",
      "--summary",
      "s.md",
    ]);
    expect(opts).toMatchObject({ repo: "o/r", only: ["main", "develop"], summary: "s.md" });
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown/);
    expect(() => parseArgs(["--branch"])).toThrow(/needs a value/);
  });
});
