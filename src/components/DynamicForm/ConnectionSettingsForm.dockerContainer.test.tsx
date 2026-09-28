import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import { listAgentDockerContainers, listDockerContainers } from "@/services/api";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/api", () => ({
  listSerialPorts: vi.fn().mockResolvedValue([]),
  listDockerContainers: vi.fn(),
  listAgentDockerContainers: vi.fn(),
}));

const mockedLocal = listDockerContainers as ReturnType<typeof vi.fn>;
const mockedAgent = listAgentDockerContainers as ReturnType<typeof vi.fn>;

const DOCKER_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "container",
      label: "Container",
      fields: [
        {
          key: "runtime",
          label: "Runtime",
          fieldType: {
            type: "select",
            options: [
              { value: "auto", label: "Auto" },
              { value: "docker", label: "Docker" },
              { value: "podman", label: "Podman" },
            ],
          },
          required: false,
          default: "auto",
        },
        {
          key: "existingContainer",
          label: "Existing Container",
          fieldType: { type: "dockerContainer" },
          required: false,
        },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockedLocal.mockReset().mockResolvedValue([]);
  mockedAgent.mockReset().mockResolvedValue({ supported: true, containers: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function renderForm(props: {
  localContainerListing?: boolean;
  containerListingAgentId?: string;
}) {
  await act(async () => {
    root.render(
      <ConnectionSettingsForm
        schema={DOCKER_SCHEMA}
        settings={{ runtime: "podman", existingContainer: "" }}
        onChange={vi.fn()}
        {...props}
      />
    );
  });
}

describe("ConnectionSettingsForm container picker source (PROD-017 / #3424)", () => {
  it("lists the local runtime's containers by default", async () => {
    await renderForm({});
    expect(mockedLocal).toHaveBeenCalledWith("podman");
    expect(mockedAgent).not.toHaveBeenCalled();
  });

  it("lists the agent host's containers when given an agent id", async () => {
    await renderForm({ localContainerListing: false, containerListingAgentId: "agent-7" });
    expect(mockedAgent).toHaveBeenCalledWith("agent-7", "podman");
    expect(mockedLocal).not.toHaveBeenCalled();
    expect(q("field-existingContainer-listing-unavailable")).toBeNull();
  });

  it("keeps the typed-only field when local listing is off and no agent id is given", async () => {
    await renderForm({ localContainerListing: false });
    expect(mockedLocal).not.toHaveBeenCalled();
    expect(mockedAgent).not.toHaveBeenCalled();
    expect(q("field-existingContainer-listing-unavailable")).not.toBeNull();
  });
});
