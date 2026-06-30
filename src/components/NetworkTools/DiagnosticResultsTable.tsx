interface Column {
  key: string;
  label: string;
}

interface DiagnosticResultsTableProps {
  columns: Column[];
  rows: Record<string, string | number | null | undefined>[];
  footer?: string | null;
  /**
   * When set, each result row is tagged `data-testid="${rowTestIdPrefix}-${index}"`
   * so the live E2E suite can address individual rows (e.g. `port-scanner-result`,
   * `dns-result`). Omit to render rows without test-ids.
   */
  rowTestIdPrefix?: string;
  /** When set, the footer is tagged with this `data-testid` (e.g. `port-scanner-footer`). */
  footerTestId?: string;
}

/** Shared results table for diagnostic panels. */
export function DiagnosticResultsTable({
  columns,
  rows,
  footer,
  rowTestIdPrefix,
  footerTestId,
}: DiagnosticResultsTableProps) {
  if (rows.length === 0 && !footer) return null;

  return (
    <div className="network-panel__table-wrapper">
      {rows.length > 0 && (
        <table className="network-panel__table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} data-testid={rowTestIdPrefix ? `${rowTestIdPrefix}-${i}` : undefined}>
                {columns.map((col) => (
                  <td key={col.key}>{row[col.key] ?? "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {footer && (
        <div className="network-panel__table-footer" data-testid={footerTestId}>
          {footer}
        </div>
      )}
    </div>
  );
}
