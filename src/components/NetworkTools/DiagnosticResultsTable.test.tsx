/**
 * Tests for the shared DiagnosticResultsTable test-id plumbing (issue #934).
 *
 * The Port Scanner and DNS Lookup panels render their result rows and footer
 * through this shared table, so the per-row and footer `data-testid`s the live
 * E2E suite needs are supplied here via props (`rowTestIdPrefix` / `footerTestId`)
 * rather than duplicated in each panel.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";

let container: HTMLDivElement;
let root: Root;

const COLUMNS = [
  { key: "port", label: "Port" },
  { key: "state", label: "State" },
];
const ROWS = [
  { port: 22, state: "open" },
  { port: 80, state: "closed" },
];

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

describe("DiagnosticResultsTable — test-id plumbing", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("tags each row with `${rowTestIdPrefix}-${index}` when the prefix is given", () => {
    render(
      <DiagnosticResultsTable columns={COLUMNS} rows={ROWS} rowTestIdPrefix="port-scanner-result" />
    );
    expect(container.querySelector('[data-testid="port-scanner-result-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="port-scanner-result-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="port-scanner-result-2"]')).toBeNull();
  });

  it("tags the footer with `footerTestId` when given", () => {
    render(
      <DiagnosticResultsTable
        columns={COLUMNS}
        rows={ROWS}
        footer="Scanned 2 ports"
        footerTestId="port-scanner-footer"
      />
    );
    const footer = container.querySelector('[data-testid="port-scanner-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toBe("Scanned 2 ports");
  });

  it("adds no row/footer test-ids when the props are omitted (e.g. other panels)", () => {
    render(<DiagnosticResultsTable columns={COLUMNS} rows={ROWS} footer="x" />);
    expect(container.querySelector("[data-testid]")).toBeNull();
  });

  it("supports a distinct prefix per panel (DNS uses `dns-result`)", () => {
    render(<DiagnosticResultsTable columns={COLUMNS} rows={ROWS} rowTestIdPrefix="dns-result" />);
    expect(container.querySelector('[data-testid="dns-result-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="port-scanner-result-0"]')).toBeNull();
  });
});
