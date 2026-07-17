import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SpawnPicker } from "./SpawnPicker";
import type { SpawnChoice } from "@/types/spawn";

vi.mock("@/services/api", () => ({
  listSpawnOptions: vi.fn(),
}));
import { listSpawnOptions, type SpawnOptions } from "@/services/api";
const mockedListSpawnOptions = vi.mocked(listSpawnOptions);

let container: HTMLDivElement;
let root: Root;

/** Radix portals render outside `container`, so query the whole document. */
function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  const el = query(testId);
  if (!el) throw new Error(`no element with testid "${testId}"`);
  act(() => {
    el.click();
  });
}

const OPTIONS: SpawnOptions = {
  shells: ["bash", "zsh"],
  wslDistros: [],
  dockerAvailable: true,
  dockerImages: ["alpine:3"],
  podmanAvailable: false,
  podmanImages: [],
};

/** Render the picker and settle the async option enumeration. */
async function renderPicker(
  options: Partial<SpawnOptions> = {},
  onConfirm: (choice: SpawnChoice) => void = vi.fn(),
  onCancel: () => void = vi.fn()
): Promise<void> {
  mockedListSpawnOptions.mockResolvedValue({ ...OPTIONS, ...options });
  await act(async () => {
    root.render(
      <SpawnPicker open location="/home/user/app" onConfirm={onConfirm} onCancel={onCancel} />
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SpawnPicker", () => {
  it("renders a row per detected shell and shows the resolved path", async () => {
    await renderPicker();

    expect(query("spawn-picker-path")?.textContent).toContain("/home/user/app");
    expect(query("spawn-picker-row-local:bash")).not.toBeNull();
    expect(query("spawn-picker-row-local:zsh")).not.toBeNull();
  });

  it("omits the WSL section when no distributions exist (every non-Windows host)", async () => {
    await renderPicker({ wslDistros: [] });

    expect(query("spawn-picker-row-wsl:Ubuntu-22.04")).toBeNull();
  });

  it("shows a WSL row per distribution when the host has them", async () => {
    await renderPicker({ wslDistros: ["Ubuntu-22.04", "Debian"] });

    expect(query("spawn-picker-row-wsl:Ubuntu-22.04")).not.toBeNull();
    expect(query("spawn-picker-row-wsl:Debian")).not.toBeNull();
  });

  it("omits a container section whose runtime is unavailable", async () => {
    await renderPicker({ dockerAvailable: false, podmanAvailable: true });

    expect(query("spawn-picker-row-container:docker")).toBeNull();
    expect(query("spawn-picker-row-container:podman")).not.toBeNull();
  });

  it("expands the inline container form only once the Docker row is selected", async () => {
    await renderPicker();

    // Collapsed while a local shell is preselected.
    expect(query("spawn-picker-form-docker")).toBeNull();

    click("spawn-picker-row-container:docker");
    expect(query("spawn-picker-form-docker")).not.toBeNull();
    expect(query("spawn-picker-mount-docker")).not.toBeNull();
  });

  it("confirms the preselected local shell", async () => {
    const onConfirm = vi.fn();
    await renderPicker({}, onConfirm);

    click("spawn-picker-open");

    expect(onConfirm).toHaveBeenCalledWith({
      target: { kind: "local", shell: "bash" },
      newWindow: false,
      remember: false,
    });
  });

  it("carries remember and the container target into the confirm payload", async () => {
    const onConfirm = vi.fn();
    await renderPicker({}, onConfirm);

    click("spawn-picker-row-container:docker");
    click("spawn-picker-remember");
    click("spawn-picker-open");

    expect(onConfirm).toHaveBeenCalledWith({
      target: {
        kind: "container",
        runtime: "docker",
        image: "ubuntu:22.04",
        mount: "/workspace",
      },
      newWindow: false,
      remember: true,
    });
  });

  it("carries the new-window choice into the confirm payload", async () => {
    const onConfirm = vi.fn();
    await renderPicker({}, onConfirm);

    click("spawn-picker-new-window");
    click("spawn-picker-open");

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ newWindow: true, remember: false })
    );
  });

  it("renders the footer options as checkboxes, not switches", async () => {
    await renderPicker();

    // Both options only take effect when Open is pressed, so the design draws
    // checkboxes (#1562). A switch would imply they apply immediately.
    for (const id of ["spawn-picker-new-window", "spawn-picker-remember"]) {
      const control = query(id) as HTMLElement;
      expect(control.getAttribute("role")).toBe("checkbox");
      expect(control.classList.contains("ui-checkbox")).toBe(true);
    }
  });

  it("cancels without confirming", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await renderPicker({}, onConfirm, onCancel);

    click("spawn-picker-cancel");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("reports no targets and blocks Open when the host offers nothing", async () => {
    await renderPicker({ shells: [], dockerAvailable: false, podmanAvailable: false });

    expect(query("spawn-picker-none")).not.toBeNull();
    expect((query("spawn-picker-open") as HTMLButtonElement).disabled).toBe(true);
  });
});
