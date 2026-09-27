/**
 * Dual-run of the reconnect-backoff golden vectors (#3730).
 *
 * The fixtures under `core/tests/fixtures/golden/reconnect_backoff/` are replayed
 * by the Rust port in `core/tests/reconnect_backoff_golden.rs`. This suite
 * replays the very same files against the TypeScript implementation, so the two
 * engines — and the shared policy constants — are pinned to one set of expected
 * values from both sides instead of by convention.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_JITTER_RATIO,
  RECONNECT_GIVE_UP_WINDOW_MS,
  RECONNECT_POLICY,
  backoffDelay,
  isActiveReconnectPhase,
  nextReconnectDelay,
  reconnectReducer,
  shouldGiveUp,
  worstCaseTotalBackoffMs,
  type BackoffConfig,
  type ReconnectEvent,
  type ReconnectPhase,
  type ReconnectState,
} from "./reconnectBackoff";

interface GoldenCase {
  name: string;
  input: unknown;
  args?: { config?: BackoffConfig; rand?: number; event?: ReconnectEvent };
  expected: unknown;
}

interface GoldenFixture {
  operation: string;
  cases: GoldenCase[];
}

const FIXTURE_DIR = join(process.cwd(), "core/tests/fixtures/golden/reconnect_backoff");

function loadFixtures(): GoldenFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as GoldenFixture);
}

function runCase(operation: string, c: GoldenCase): unknown {
  const config = c.args?.config as BackoffConfig;
  const r = c.args?.rand ?? 0.5;
  const rand = () => r;
  switch (operation) {
    case "backoffDelay":
      return backoffDelay(c.input as number, config);
    case "nextReconnectDelay":
      return nextReconnectDelay(c.input as number, config, rand);
    case "shouldGiveUp":
      return shouldGiveUp(c.input as number, config);
    case "reconnectReducer":
      return reconnectReducer(
        c.input as ReconnectState,
        c.args?.event as ReconnectEvent,
        config,
        rand
      );
    case "isActiveReconnectPhase":
      return isActiveReconnectPhase(c.input as ReconnectPhase);
    case "worstCaseTotalBackoffMs":
      return worstCaseTotalBackoffMs(c.input as BackoffConfig);
    case "reconnectPolicy":
      switch (c.input) {
        case null:
          return RECONNECT_POLICY;
        case "default":
          // The Rust `DEFAULT_BACKOFF` alias; TypeScript uses RECONNECT_POLICY directly.
          return RECONNECT_POLICY;
        case "giveUpWindowMs":
          return RECONNECT_GIVE_UP_WINDOW_MS;
        case "maxJitterRatio":
          return MAX_JITTER_RATIO;
        default:
          throw new Error(`unknown reconnectPolicy input: ${String(c.input)}`);
      }
    default:
      throw new Error(`unknown golden operation: ${operation}`);
  }
}

describe("reconnectBackoff — golden vectors shared with the Rust port", () => {
  const fixtures = loadFixtures();

  it("loads a meaningful body of cases", () => {
    const total = fixtures.reduce((n, f) => n + f.cases.length, 0);
    expect(total).toBeGreaterThanOrEqual(45);
  });

  for (const fixture of fixtures) {
    for (const c of fixture.cases) {
      it(`${fixture.operation} :: ${c.name}`, () => {
        const actual = runCase(fixture.operation, c);
        if (typeof c.expected === "number") {
          expect(actual).toBeCloseTo(c.expected, 9);
        } else {
          expect(actual).toEqual(c.expected);
        }
      });
    }
  }
});
