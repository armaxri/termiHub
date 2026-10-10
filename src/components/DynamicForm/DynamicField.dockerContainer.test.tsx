import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsField } from "@/types/schema";
import type { DockerContainerInfo } from "@/services/api";
import { listAgentDockerContainers, listDockerContainers } from "@/services/api";
import {
  DynamicField,
  containerMatches,
  filterComposeServiceGroups,
  type ContainerContext,
} from "./DynamicField";

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

describe("DynamicField dockerContainer picker compose awareness (#3425)", () => {
  const compose = (name: string, project: string, service: string, running = true) =>
    info(name, running, { composeProject: project, composeService: service });

  it("groups mixed compose and plain containers by project, plain ones last", async () => {
    mockedList.mockResolvedValue([
      compose("shop-web-1", "shop", "web"),
      info("standalone", true),
      compose("blog-db-1", "blog", "db"),
      compose("shop-db-1", "shop", "db", false),
    ]);
    await render("");
    const labels = [...container.querySelectorAll(".settings-form__container-group-label")].map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["Compose project: blog", "Compose project: shop", "Other containers"]);
    const shopGroup = q("field-existingContainer-group-project-shop")?.parentElement;
    expect(
      shopGroup?.querySelector('[data-testid="field-existingContainer-option-shop-web-1"]')
    ).not.toBeNull();
    expect(
      shopGroup?.querySelector('[data-testid="field-existingContainer-option-shop-db-1"]')
    ).not.toBeNull();
    const otherGroup = q("field-existingContainer-group-other")?.parentElement;
    expect(
      otherGroup?.querySelector('[data-testid="field-existingContainer-option-standalone"]')
    ).not.toBeNull();
  });

  it("shows the service name and still selects by container name", async () => {
    mockedList.mockResolvedValue([compose("shop-web-1", "shop", "web")]);
    const onChange = await render("");
    expect(q("field-existingContainer-service-shop-web-1")?.textContent).toBe("service: web");
    act(() => q("field-existingContainer-option-shop-web-1")?.click());
    expect(onChange).toHaveBeenCalledWith("shop-web-1");
  });

  it("renders a flat list without group headers when nothing is from compose", async () => {
    mockedList.mockResolvedValue([info("web", true), info("worker", true)]);
    await render("");
    expect(container.querySelector(".settings-form__container-group-label")).toBeNull();
    expect(q("field-existingContainer-option-web")).not.toBeNull();
  });

  it("filters by project and service name", async () => {
    mockedList.mockResolvedValue([
      compose("shop-web-1", "shop", "frontend"),
      compose("blog-api-1", "blog", "api"),
      info("standalone", true),
    ]);
    await render("frontend");
    expect(q("field-existingContainer-option-shop-web-1")).not.toBeNull();
    expect(q("field-existingContainer-option-blog-api-1")).toBeNull();
    await render("blog");
    expect(q("field-existingContainer-option-blog-api-1")).not.toBeNull();
    expect(q("field-existingContainer-option-standalone")).toBeNull();
  });

  it("groups an agent host's compose containers the same way", async () => {
    mockedAgentList.mockResolvedValue({
      supported: true,
      containers: [compose("shop-web-1", "shop", "web"), info("plain", true)],
    });
    await render("", vi.fn(), { runtime: "docker", listingEnabled: true, agentId: "a1" });
    expect(q("field-existingContainer-group-project-shop")).not.toBeNull();
    expect(q("field-existingContainer-group-other")).not.toBeNull();
  });
});

describe("DynamicField dockerContainer picker in Compose-service mode (#3784)", () => {
  const serviceField: SettingsField = {
    key: "composeService",
    label: "Compose Service",
    fieldType: { type: "dockerContainer" },
    required: true,
    placeholder: "my-project/web",
  };

  async function renderService(value: unknown, onChange = vi.fn(), context?: ContainerContext) {
    await act(async () => {
      root.render(
        <DynamicField
          field={serviceField}
          value={value}
          onChange={onChange}
          containerContext={context}
        />
      );
    });
    return onChange;
  }

  const compose = (name: string, project: string, service: string, running = true) =>
    info(name, running, { composeProject: project, composeService: service });

  it("lists services (replicas collapsed) and stores project/service on pick", async () => {
    mockedList.mockResolvedValue([
      compose("shop-web-1", "shop", "web"),
      compose("shop-web-2", "shop", "web", false),
      compose("shop-db-1", "shop", "db", false),
      info("plain", true),
    ]);
    const onChange = await renderService("");
    expect(q("field-composeService-group-project-shop")?.textContent).toContain("shop");
    expect(q("field-composeService-option-shop/web")?.textContent).toContain("1 of 2 running");
    expect(q("field-composeService-option-shop/db")?.textContent).toContain("not running");
    // Containers outside Compose are not services.
    expect(q("field-composeService-option-plain")).toBeNull();
    act(() => q("field-composeService-option-shop/web")?.click());
    expect(onChange).toHaveBeenCalledWith("shop/web");
  });

  it("marks the saved service selected and keeps the full list", async () => {
    mockedList.mockResolvedValue([
      compose("shop-web-1", "shop", "web"),
      compose("shop-db-1", "shop", "db"),
    ]);
    await renderService("shop/web");
    expect(q("field-composeService-option-shop/web")?.getAttribute("aria-pressed")).toBe("true");
    expect(q("field-composeService-option-shop/db")).not.toBeNull();
  });

  it("filters by the typed text and keeps an unlisted value as typed", async () => {
    mockedList.mockResolvedValue([
      compose("shop-web-1", "shop", "web"),
      compose("blog-app-1", "blog", "app"),
    ]);
    await renderService("blo");
    expect(q("field-composeService-option-blog/app")).not.toBeNull();
    expect(q("field-composeService-option-shop/web")).toBeNull();
    await renderService("gone/svc");
    expect(q("field-composeService-list")).toBeNull();
    expect(q("field-composeService-no-match")).not.toBeNull();
  });

  it("says when the runtime has no Compose services", async () => {
    mockedList.mockResolvedValue([info("plain", true)]);
    await renderService("");
    expect(q("field-composeService-empty")?.textContent).toContain("No Docker Compose services");
  });

  it("asks for project/service when listing is unavailable", async () => {
    await renderService("", vi.fn(), { listingEnabled: false });
    expect(q("field-composeService-listing-unavailable")?.textContent).toContain("project/service");
  });
});

describe("dockerContainer picker filters (#4582)", () => {
  it("matches name, image and compose fields diacritic-insensitively", () => {
    const c = info("müller-db", true, { composeProject: "Café", composeService: "worker" });
    expect(containerMatches(c, "muller")).toBe(true);
    expect(containerMatches(c, "cafe")).toBe(true);
    expect(containerMatches(c, "UBUNTU")).toBe(true);
    expect(containerMatches(c, "WORK")).toBe(true);
    expect(containerMatches(c, "")).toBe(true);
    expect(containerMatches(c, "postgres")).toBe(false);
  });

  it("keeps the container ID a prefix match", () => {
    const c = info("web", true, { id: "abc123def456" });
    expect(containerMatches(c, "ABC1")).toBe(true);
    expect(containerMatches(c, "def456")).toBe(false);
  });

  it("filters compose services diacritic-insensitively and drops empty groups", () => {
    const groups = [
      { project: "shop", services: [{ value: "shop/müller-api" }, { value: "shop/db" }] },
      { project: "blog", services: [{ value: "blog/web" }] },
    ];
    expect(filterComposeServiceGroups(groups, "muller")).toEqual([
      { project: "shop", services: [{ value: "shop/müller-api" }] },
    ]);
    expect(filterComposeServiceGroups(groups, "")).toEqual(groups);
  });
});
