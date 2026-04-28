import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AboutSettings } from "./AboutSettings";

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

const { openUrl } = await import("@tauri-apps/plugin-opener");
// setup.ts mocks the entire module; vi.mocked gives typed access to the spy
const mockedOpenUrl = vi.mocked(openUrl);

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<AboutSettings />);
  });
}

describe("AboutSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_app_info")
        return Promise.resolve({ version: "1.2.3", gitHash: "abc1234", isDev: false });
      return Promise.resolve(undefined);
    });

    mockedOpenUrl.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the About category heading", () => {
    render();
    const heading = container.querySelector(".settings-panel__category-title");
    expect(heading?.textContent).toBe("About");
  });

  it("shows the app name", () => {
    render();
    expect(container.textContent).toContain("termiHub");
  });

  it("shows the version after app info loads", async () => {
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='about-version']")?.textContent).toContain(
      "1.2.3"
    );
  });

  it("shows the git hash after app info loads", async () => {
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='about-git-hash']")?.textContent).toContain(
      "abc1234"
    );
  });

  it("shows a project description / tagline", () => {
    render();
    expect(container.querySelector("[data-testid='about-description']")).not.toBeNull();
  });

  it("shows the MIT license label", () => {
    render();
    expect(container.textContent).toContain("MIT");
  });

  it("has a GitHub repository link button", () => {
    render();
    const btn = container.querySelector("[data-testid='about-github-link']");
    expect(btn).not.toBeNull();
  });

  it("opens the GitHub URL when the link button is clicked", async () => {
    render();
    const btn = container.querySelector("[data-testid='about-github-link']") as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://github.com/armaxri/termiHub");
  });

  it("has a link to the full license text", () => {
    render();
    const btn = container.querySelector("[data-testid='about-license-link']");
    expect(btn).not.toBeNull();
  });

  it("opens the license URL when the license link is clicked", async () => {
    render();
    const btn = container.querySelector("[data-testid='about-license-link']") as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    expect(mockedOpenUrl).toHaveBeenCalledWith(
      "https://github.com/armaxri/termiHub/blob/main/LICENSE"
    );
  });
});
