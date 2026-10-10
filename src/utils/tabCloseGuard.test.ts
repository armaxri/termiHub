/**
 * Tests for the shared single-tab unsaved-changes guard (#4410), used by both
 * the tab X (`TabBar.handleCloseTab`) and the close-tab shortcut.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store/appStore";
import type { TabContentType } from "@/types/terminal";
import {
  SELF_PROMPTING_CONTENT_TYPES,
  rendersOwnUnsavedPrompt,
  routeDirtyTabClose,
} from "./tabCloseGuard";

beforeEach(() => {
  useAppStore.setState({ editorDirtyTabs: {}, pendingCloseRequest: null });
});

describe("SELF_PROMPTING_CONTENT_TYPES", () => {
  it("lists exactly the editors that render their own unsaved-changes dialog", () => {
    expect([...SELF_PROMPTING_CONTENT_TYPES].sort()).toEqual(
      ["connection-editor", "editor", "settings", "tunnel-editor", "workspace-editor"].sort()
    );
  });

  it("rendersOwnUnsavedPrompt matches the list", () => {
    expect(rendersOwnUnsavedPrompt("editor")).toBe(true);
    expect(rendersOwnUnsavedPrompt("terminal")).toBe(false);
    expect(rendersOwnUnsavedPrompt(undefined)).toBe(false);
  });
});

describe("routeDirtyTabClose", () => {
  it("returns clean and changes nothing for a tab without unsaved edits", () => {
    expect(routeDirtyTabClose({ id: "t1", contentType: "editor" }, "p1")).toBe("clean");
    expect(useAppStore.getState().pendingCloseRequest).toBeNull();
  });

  it.each([...SELF_PROMPTING_CONTENT_TYPES])(
    "hands a dirty %s tab to its own prompt via pendingCloseRequest",
    (contentType: TabContentType) => {
      useAppStore.setState({ editorDirtyTabs: { t1: true } });
      expect(routeDirtyTabClose({ id: "t1", contentType }, "p1")).toBe("self-prompt");
      expect(useAppStore.getState().pendingCloseRequest).toEqual({ tabId: "t1", panelId: "p1" });
    }
  );

  it("asks for the generic prompt for another dirty tab type", () => {
    useAppStore.setState({ editorDirtyTabs: { t1: true } });
    expect(routeDirtyTabClose({ id: "t1", contentType: "network-diagnostic" }, "p1")).toBe(
      "generic-prompt"
    );
    expect(useAppStore.getState().pendingCloseRequest).toBeNull();
  });

  it("asks for the generic prompt for a dirty tab of unknown content type", () => {
    useAppStore.setState({ editorDirtyTabs: { t1: true } });
    expect(routeDirtyTabClose({ id: "t1" }, "p1")).toBe("generic-prompt");
  });
});
