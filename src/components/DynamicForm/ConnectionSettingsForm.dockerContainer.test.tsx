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

describe("ConnectionSettingsForm Compose-service option (#3784)", () => {
  // Mirrors the backend Docker schema's container-mode select and its two
  // conditionally visible target fields.
  const MODE_SCHEMA: SettingsSchema = {
    groups: [
      {
        key: "container",
        label: "Container",
        fields: [
          {
            key: "containerMode",
            label: "Container",
            fieldType: {
              type: "select",
              options: [
                { value: "new", label: "New container" },
                { value: "existing", label: "Existing (running) container" },
                { value: "compose", label: "Compose service" },
              ],
            },
            required: false,
            default: "new",
          },
          {
            key: "existingContainer",
            label: "Existing Container",
            fieldType: { type: "dockerContainer" },
            required: true,
            visibleWhen: { field: "containerMode", equals: "existing" },
          },
          {
            key: "composeService",
            label: "Compose Service",
            fieldType: { type: "dockerContainer" },
            required: true,
            visibleWhen: { field: "containerMode", equals: "compose" },
          },
        ],
      },
    ],
  };

  async function renderMode(settings: Record<string, unknown>) {
    await act(async () => {
      root.render(
        <ConnectionSettingsForm schema={MODE_SCHEMA} settings={settings} onChange={vi.fn()} />
      );
    });
  }

  it("shows the Compose-service picker only in compose mode", async () => {
    mockedLocal.mockResolvedValue([
      {
        id: "w1",
        name: "shop-web-1",
        image: "nginx",
        state: "running",
        status: "Up",
        running: true,
        composeProject: "shop",
        composeService: "web",
      },
    ]);
    await renderMode({ containerMode: "compose", composeService: "" });
    expect(q("field-composeService")).not.toBeNull();
    expect(q("field-existingContainer")).toBeNull();
    expect(q("field-composeService-option-shop/web")).not.toBeNull();
  });

  it("keeps the existing-container picker for existing mode", async () => {
    await renderMode({ containerMode: "existing", existingContainer: "" });
    expect(q("field-composeService")).toBeNull();
    expect(q("field-existingContainer")).not.toBeNull();
  });
});
