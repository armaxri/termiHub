/**
 * TS → agent contract test for the `connections.*` RPC params (AGT-028).
 *
 * Builds representative payloads with the real frontend builders (the ones the
 * connection editor and the store actions call) and pins them to the committed
 * fixture `core/tests/fixtures/contract/agent_connection_params.json`. The Rust
 * side (`core/tests/agent_connection_params_contract.rs`) decodes every case into
 * the shared core DTO and asserts the re-encoded JSON is byte-identical — so a
 * key the DTO does not know, a wrong JSON type, or a `null` where the DTO means
 * "omit" fails `cargo test`, and any change to what the builders emit fails this
 * test until the fixture is regenerated (`pnpm exec vitest run -u <this file>`)
 * and the Rust side re-validates it.
 */
import { describe, it, expect } from "vitest";
import {
  buildAgentConnectionCreate,
  buildAgentConnectionMove,
  buildAgentConnectionUpdate,
  buildAgentFolderExpanded,
  type AgentConnectionDraft,
} from "./agentConnectionPayloads";

const FIXTURE = "../../core/tests/fixtures/contract/agent_connection_params.json";

const SSH_DRAFT: AgentConnectionDraft = {
  name: "Build Box",
  type: "ssh",
  config: { host: "build.example.com", port: 22, username: "ci", authMethod: "key" },
  persistent: true,
  terminalOptions: { fontFamily: "Hack", fontSize: 14 },
  icon: "server",
};

const BARE_DRAFT: AgentConnectionDraft = {
  name: "Scratch",
  type: "local",
  config: {},
  persistent: false,
};

/** Every case the Rust contract test decodes, keyed by JSON-RPC method. */
function buildCases(): Array<{ name: string; method: string; params: unknown }> {
  return [
    {
      name: "create: full definition inside a folder",
      method: "connections.create",
      params: buildAgentConnectionCreate(SSH_DRAFT, "folder-1"),
    },
    {
      name: "create: defaults at the root (no terminal options, no icon)",
      method: "connections.create",
      params: buildAgentConnectionCreate(BARE_DRAFT, null),
    },
    {
      name: "update: editor save with terminal options and icon",
      method: "connections.update",
      params: buildAgentConnectionUpdate("conn-1", SSH_DRAFT),
    },
    {
      name: "update: editor save clearing terminal options and icon",
      method: "connections.update",
      params: buildAgentConnectionUpdate("conn-2", BARE_DRAFT),
    },
    {
      name: "update: move into a folder",
      method: "connections.update",
      params: buildAgentConnectionMove("conn-3", "folder-2"),
    },
    {
      name: "update: move to the root",
      method: "connections.update",
      params: buildAgentConnectionMove("conn-3", null),
    },
    {
      name: "folders.update: expand",
      method: "connections.folders.update",
      params: buildAgentFolderExpanded("folder-1", true),
    },
    {
      name: "folders.update: collapse",
      method: "connections.folders.update",
      params: buildAgentFolderExpanded("folder-1", false),
    },
  ];
}

describe("agent connections.* payload contract (AGT-028)", () => {
  it("frontend-built payloads match the fixture the Rust DTO contract test decodes", async () => {
    const fixture = { cases: buildCases() };
    await expect(`${JSON.stringify(fixture, null, 2)}\n`).toMatchFileSnapshot(FIXTURE);
  });
});
