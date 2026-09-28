import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsField } from "@/types/schema";
import type { DockerContainerInfo } from "@/services/api";
import { listAgentDockerContainers, listDockerContainers } from "@/services/api";
import { DynamicField, type ContainerContext } from "./DynamicField";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/services/api", () => ({
  listSerialPorts: vi.fn().mockResolvedValue([]),
  listDockerContainers: vi.fn(),
  listAgentDockerContainers: vi.fn(),
}));

const mockedList = listDockerContainers as ReturnType<typeof vi.fn>;
const mockedAgentList = listAgentDockerContainers as ReturnType<typeof vi.fn>;

const field: SettingsField = {
  key: "existingContainer",
  label: "Existing Container",
  fieldType: { type: "dockerContainer" },
  required: true,
  placeholder: "my-running-container",
};

function info(name: string, running: boolean, extra: Partial<DockerContainerInfo> = {}) {
  return {
    id: `${name}-0123456789abcdef`,
    name,
    image: "ubuntu:22.04",
    state: running ? "running" : "exited",
    status: running ? "Up 2 hours" : "Exited (0) 1 day ago",
    running,
    ...extra,
  } satisfies DockerContainerInfo;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockedList.mockReset();
  mockedAgentList.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function render(value: unknown, onChange = vi.fn(), context?: ContainerContext) {
  await act(async () => {
    root.render(
      <DynamicField field={field} value={value} onChange={onChange} containerContext={context} />
    );
  });
  return onChange;
}

describe("DynamicField dockerContainer picker (PROD-017)", () => {
  it("shows a loading hint while the list is pending", async () => {
    mockedList.mockReturnValue(new Promise(() => {}));
    await render("");
    expect(q("field-existingContainer-loading")).not.toBeNull();
    expect(q("field-existingContainer-refresh")).toHaveProperty("disabled", true);
  });

  it("lists containers for the selected runtime and selects one on click", async () => {
    mockedList.mockResolvedValue([info("web", true), info("old-db", false)]);
    const onChange = await render("", vi.fn(), { runtime: "podman", listingEnabled: true });
    expect(mockedList).toHaveBeenCalledWith("podman");
    expect(q("field-existingContainer-option-web")?.textContent).toContain("Up 2 hours");
    expect(q("field-existingContainer-option-old-db")?.textContent).toContain("not running");
    act(() => q("field-existingContainer-option-web")?.click());
    expect(onChange).toHaveBeenCalledWith("web");
  });

  it("filters the list by the typed text and keeps the typed fallback", async () => {
    mockedList.mockResolvedValue([info("web", true), info("worker", true)]);
    await render("wor");
    expect(q("field-existingContainer-option-worker")).not.toBeNull();
    expect(q("field-existingContainer-option-web")).toBeNull();

    await render("something-else");
    expect(q("field-existingContainer-list")).toBeNull();
    expect(q("field-existingContainer-no-match")).not.toBeNull();
    expect((q("field-existingContainer") as HTMLInputElement).value).toBe("something-else");
  });

  it("shows the whole list and marks the selection when the value matches exactly", async () => {
    mockedList.mockResolvedValue([info("web", true), info("worker", true)]);
    await render("web");
    expect(q("field-existingContainer-option-worker")).not.toBeNull();
    expect(q("field-existingContainer-option-web")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("typing into the input reports the typed value", async () => {
    mockedList.mockResolvedValue([]);
    const onChange = await render("");
    const input = q("field-existingContainer") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "abc123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("abc123");
    expect(q("field-existingContainer-empty")).not.toBeNull();
  });

  it("shows the runtime error and still allows typing", async () => {
    mockedList.mockRejectedValue("daemon unreachable");
    await render("my-app");
    expect(q("field-existingContainer-list-error")?.textContent).toContain("daemon unreachable");
    expect((q("field-existingContainer") as HTMLInputElement).disabled).toBe(false);
  });

  it("refresh re-queries the runtime", async () => {
    mockedList.mockResolvedValueOnce([]).mockResolvedValueOnce([info("fresh", true)]);
    await render("");
    expect(q("field-existingContainer-empty")).not.toBeNull();
    await act(async () => {
      q("field-existingContainer-refresh")?.click();
    });
    expect(mockedList).toHaveBeenCalledTimes(2);
    expect(q("field-existingContainer-option-fresh")).not.toBeNull();
  });

  it("does not list local containers for agent-hosted connections", async () => {
    await render("my-app", vi.fn(), { listingEnabled: false });
    expect(mockedList).not.toHaveBeenCalled();
    expect(q("field-existingContainer-listing-unavailable")).not.toBeNull();
    expect(q("field-existingContainer-refresh")).toBeNull();
  });

  it("shows a structured backend error's message, not [object Object]", async () => {
    mockedList.mockRejectedValue({ code: "remote_error", message: "daemon unreachable" });
    await render("my-app");
    const text = q("field-existingContainer-list-error")?.textContent ?? "";
    expect(text).toContain("daemon unreachable");
    expect(text).not.toContain("[object Object]");
  });
});

describe("DynamicField dockerContainer picker on an agent-hosted connection (#3424)", () => {
  const agentContext: ContainerContext = { runtime: "docker", listingEnabled: true, agentId: "a1" };

  it("lists the agent host's containers, not the local runtime's", async () => {
    mockedAgentList.mockResolvedValue({
      supported: true,
      containers: [info("remote-web", true), info("remote-old", false)],
    });
    const onChange = await render("", vi.fn(), agentContext);
    expect(mockedAgentList).toHaveBeenCalledWith("a1", "docker");
    expect(mockedList).not.toHaveBeenCalled();
    expect(q("field-existingContainer-option-remote-web")?.textContent).toContain("Up 2 hours");
    expect(q("field-existingContainer-option-remote-old")?.textContent).toContain("not running");
    act(() => q("field-existingContainer-option-remote-web")?.click());
    expect(onChange).toHaveBeenCalledWith("remote-web");
  });

  it("degrades to the typed field for an agent too old to list containers", async () => {
    mockedAgentList.mockResolvedValue({ supported: false, containers: [] });
    const onChange = await render("my-app", vi.fn(), agentContext);
    expect(q("field-existingContainer-listing-unsupported")?.textContent).toContain(
      "update the agent"
    );
    expect(q("field-existingContainer-list")).toBeNull();
    expect(q("field-existingContainer-list-error")).toBeNull();
    expect(q("field-existingContainer-refresh")).toBeNull();
    const input = q("field-existingContainer") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("my-app");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "typed-id");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("typed-id");
  });

  it("shows the agent's runtime error and still allows typing", async () => {
    mockedAgentList.mockRejectedValue({
      code: "remote_error",
      message: "Cannot connect to the Docker daemon",
    });
    await render("my-app", vi.fn(), agentContext);
    expect(q("field-existingContainer-list-error")?.textContent).toContain(
      "Cannot connect to the Docker daemon"
    );
    expect((q("field-existingContainer") as HTMLInputElement).disabled).toBe(false);
  });

  it("refresh re-queries the agent", async () => {
    mockedAgentList
      .mockResolvedValueOnce({ supported: true, containers: [] })
      .mockResolvedValueOnce({ supported: true, containers: [info("fresh", true)] });
    await render("", vi.fn(), agentContext);
    expect(q("field-existingContainer-empty")).not.toBeNull();
    await act(async () => {
      q("field-existingContainer-refresh")?.click();
    });
    expect(mockedAgentList).toHaveBeenCalledTimes(2);
    expect(q("field-existingContainer-option-fresh")).not.toBeNull();
  });
});
