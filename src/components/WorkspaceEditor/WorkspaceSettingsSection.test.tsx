import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

import { WorkspaceSettingsSection } from "./WorkspaceSettingsSection";
import { withTooltip } from "@/test/tooltip";
import type { WorkspaceSettings } from "@/types/workspace";

vi.mock("@/themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/themes")>();
  return { ...actual, applyTheme: vi.fn() };
});

let container: HTMLDivElement;
let root: Root;

function render(value: WorkspaceSettings, onChange = vi.fn()) {
  act(() => {
    root.render(withTooltip(<WorkspaceSettingsSection value={value} onChange={onChange} />));
  });
  return onChange;
}

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkspaceSettingsSection (PROD-052)", () => {
  it("renders every overridable field", () => {
    render({});
    for (const id of [
      "workspace-settings-theme",
      "workspace-settings-font-family",
      "workspace-settings-font-size",
      "workspace-settings-default-dir",
      "workspace-settings-env-add",
    ]) {
      expect(q(id), id).not.toBeNull();
    }
  });

  it("adds an empty environment variable row", () => {
    const onChange = render({});
    act(() => q("workspace-settings-env-add")?.click());
    expect(onChange).toHaveBeenCalledWith({ envVars: [{ key: "", value: "" }] });
  });

  it("removes an environment variable row", () => {
    const onChange = render({
      envVars: [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ],
    });
    act(() => q("workspace-settings-env-remove-0")?.click());
    expect(onChange).toHaveBeenCalledWith({ envVars: [{ key: "B", value: "2" }] });
  });

  it("shows an inline error for an invalid variable name", () => {
    render({ envVars: [{ key: "BAD-NAME", value: "x" }] });
    expect(q("workspace-settings-env-field-0")?.textContent).toMatch(/letters, digits/);
  });

  it("warns when a variable name looks like a secret", () => {
    render({ envVars: [{ key: "API_TOKEN", value: "x" }] });
    expect(q("workspace-settings-env-field-0")?.textContent).toMatch(/plain text/);
  });

  it("reports edits to the default working directory", () => {
    const onChange = render({});
    const input = q("workspace-settings-default-dir") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "/srv/app");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ defaultWorkingDirectory: "/srv/app" });
  });
});
