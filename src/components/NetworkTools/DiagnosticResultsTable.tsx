interface Column {
  key: string;
  label: string;
}

interface DiagnosticResultsTableProps {
  columns: Column[];
  rows: Record<string, string | number | null | undefined>[];
  footer?: string | null;
}

/** Shared results table for diagnostic panels. */
export function DiagnosticResultsTable({ columns, rows, footer }: DiagnosticResultsTableProps) {
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
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col.key}>{row[col.key] ?? "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {footer && <div className="network-panel__table-footer">{footer}</div>}
    </div>
  );
}
