import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThirdPartyNoticesDialog, THIRD_PARTY_LICENSES_URL } from "./ThirdPartyNoticesDialog";

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

const { openUrl } = await import("@tauri-apps/plugin-opener");
const mockedOpenUrl = vi.mocked(openUrl);

let container: HTMLDivElement;
let root: Root;

async function render(open: boolean) {
  await act(async () => {
    root.render(<ThirdPartyNoticesDialog open={open} onOpenChange={() => {}} />);
  });
}

const byTestId = (id: string) => document.querySelector(`[data-testid='${id}']`);

describe("ThirdPartyNoticesDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockedOpenUrl.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("does not fetch the notices while closed", async () => {
    await render(false);
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_third_party_notices");
    expect(byTestId("third-party-notices-dialog")).toBeNull();
  });

  it("shows the bundled notices text once opened", async () => {
    mockedInvoke.mockResolvedValue("termiHub - Third-Party Notices\n\nserde 1.0.0 - MIT");
    await render(true);
    expect(mockedInvoke).toHaveBeenCalledWith("get_third_party_notices");
    expect(byTestId("third-party-notices-text")?.textContent).toContain("serde 1.0.0 - MIT");
  });

  it("fetches only once across re-opens", async () => {
    mockedInvoke.mockResolvedValue("notices");
    await render(true);
    await render(false);
    await render(true);
    const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_third_party_notices");
    expect(calls).toHaveLength(1);
  });

  it("explains when the build does not bundle the notices", async () => {
    mockedInvoke.mockResolvedValue(null);
    await render(true);
    expect(byTestId("third-party-notices-unavailable")?.textContent).toContain(
      "not bundled in this build"
    );
  });

  it("shows an error when loading fails", async () => {
    mockedInvoke.mockRejectedValue(new Error("boom"));
    await render(true);
    expect(byTestId("third-party-notices-error")?.textContent).toContain("boom");
  });

  it("opens the online attribution page from the footer", async () => {
    mockedInvoke.mockResolvedValue(null);
    await render(true);
    const btn = byTestId("third-party-notices-online") as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    expect(mockedOpenUrl).toHaveBeenCalledWith(THIRD_PARTY_LICENSES_URL);
  });
});
