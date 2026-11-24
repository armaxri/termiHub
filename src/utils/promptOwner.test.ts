import { describe, it, expect } from "vitest";
import { parsePromptOwner, promptConnectionName } from "./promptOwner";

describe("parsePromptOwner", () => {
  it("splits a terminal connect id into tab and attempt", () => {
    expect(parsePromptOwner("tab-1:2")).toEqual({ tabId: "tab-1", attempt: 2 });
    expect(parsePromptOwner("a:b:0")).toEqual({ tabId: "a:b", attempt: 0 });
  });

  it("rejects anything that is not one", () => {
    expect(parsePromptOwner("tab")).toBeNull();
    expect(parsePromptOwner(":1")).toBeNull();
    expect(parsePromptOwner("tab:x")).toBeNull();
  });
});

describe("promptConnectionName (#5862)", () => {
  const tabs = [
    { id: "tab-1", title: "prod web" },
    { id: "tab-2", title: "  " },
  ];

  it("names the connection of the tab that raised the prompt", () => {
    expect(promptConnectionName("tab-1:0", tabs)).toBe("prod web");
  });

  it("is undefined without an owning tab", () => {
    expect(promptConnectionName(null, tabs)).toBeUndefined();
    expect(promptConnectionName("tab-9:0", tabs)).toBeUndefined();
    expect(promptConnectionName("tab-2:0", tabs)).toBeUndefined();
  });
});
