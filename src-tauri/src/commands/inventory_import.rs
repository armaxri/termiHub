//! Tauri command for bulk host onboarding (#1961): parse a CSV / simple
//! inventory file into a list of [`InventoryHost`] rows that the frontend stamps
//! onto a chosen connection **template** (shared creds/type/jump-host), creating
//! one saved connection per host in a single action.
//!
//! This is the file-side counterpart of [`ssh_config_import`](super::ssh_config_import):
//! it only *parses* an inventory into DTOs — it never creates connections. The
//! frontend applies the template and persists via `save_connection`.
//!
//! Parsing is delegated to the maintained [`csv`] crate (library-first per the
//! repo rules) rather than hand-rolling quoting / delimiter handling.
//!
//! ## Accepted formats
//!
//! - **CSV with a header row** naming any of `host`/`hostname`/`address`/`ip`,
//!   `label`/`name`, `port`, `user`/`username` (case-insensitive, any order).
//!   Unknown columns are ignored.
//! - **Header-less CSV** — positional `host,label,port,username`.
//! - **A plain host-per-line list** (a single column, no commas) — each line is
//!   a host, its label defaulting to the host.
//!
//! `#` comment lines and blank lines are skipped. A row without a host is
//! skipped. An unparseable `port` degrades to "no override" rather than failing
//! the whole import.

use std::path::Path;

use serde::Serialize;

use crate::utils::errors::TerminalError;

/// One host parsed from an inventory file, offered to the frontend to stamp onto
/// a connection template.
///
/// `label` is the display name for the created connection (falls back to `host`
/// when the file gives no label). `port`/`username` are *optional per-host
/// overrides* — `None` means "inherit the template's value".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryHost {
    pub label: String,
    pub host: String,
    pub port: Option<u16>,
    pub username: Option<String>,
}

/// Which inventory column each recognised field maps to, resolved from the
/// header row. `None` for a field means the file has no such column.
#[derive(Default)]
struct ColumnMap {
    host: Option<usize>,
    label: Option<usize>,
    port: Option<usize>,
    username: Option<usize>,
}

/// Classify a header cell into the field it names, or `None` when it is not a
/// recognised header keyword.
fn classify_header(cell: &str) -> Option<Field> {
    match cell.trim().to_ascii_lowercase().as_str() {
        "host" | "hostname" | "address" | "ip" => Some(Field::Host),
        "label" | "name" => Some(Field::Label),
        "port" => Some(Field::Port),
        "user" | "username" => Some(Field::Username),
        _ => None,
    }
}

enum Field {
    Host,
    Label,
    Port,
    Username,
}

/// Decide whether `record` is a header row and, if so, build the column map from
/// it. A row is treated as a header when at least one cell names a recognised
/// field. Returns `None` when the file is header-less (positional layout).
fn header_map(record: &csv::StringRecord) -> Option<ColumnMap> {
    let mut map = ColumnMap::default();
    let mut matched = false;
    for (idx, cell) in record.iter().enumerate() {
        match classify_header(cell) {
            Some(Field::Host) => {
                map.host.get_or_insert(idx);
                matched = true;
            }
            Some(Field::Label) => {
                map.label.get_or_insert(idx);
                matched = true;
            }
            Some(Field::Port) => {
                map.port.get_or_insert(idx);
                matched = true;
            }
            Some(Field::Username) => {
                map.username.get_or_insert(idx);
                matched = true;
            }
            None => {}
        }
    }
    matched.then_some(map)
}

/// The positional column map used when no header row is present:
/// `host,label,port,username`.
fn positional_map() -> ColumnMap {
    ColumnMap {
        host: Some(0),
        label: Some(1),
        port: Some(2),
        username: Some(3),
    }
}

/// Read `cell` at `idx` (if any), trimmed; `None`/empty collapses to `None`.
fn cell_at(record: &csv::StringRecord, idx: Option<usize>) -> Option<String> {
    let value = idx.and_then(|i| record.get(i))?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Turn one data record into an [`InventoryHost`] using `map`. Rows without a
/// host resolve to `None` and are skipped by the caller.
fn record_to_host(record: &csv::StringRecord, map: &ColumnMap) -> Option<InventoryHost> {
    let host = cell_at(record, map.host)?;
    let label = cell_at(record, map.label).unwrap_or_else(|| host.clone());
    // A malformed port is dropped (no override) rather than failing the import.
    let port = cell_at(record, map.port).and_then(|p| p.parse::<u16>().ok());
    let username = cell_at(record, map.username);
    Some(InventoryHost {
        label,
        host,
        port,
        username,
    })
}

/// Parse an inventory from raw bytes. Shared by the command and the tests so both
/// exercise the exact same header-detection and mapping path.
pub fn parse_inventory_bytes(bytes: &[u8]) -> Result<Vec<InventoryHost>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .comment(Some(b'#'))
        .trim(csv::Trim::All)
        .from_reader(bytes);

    let mut records = reader.records();
    let Some(first) = records.next() else {
        return Ok(Vec::new());
    };
    let first = first.map_err(|e| format!("parse inventory: {e}"))?;

    let mut out = Vec::new();
    let map = match header_map(&first) {
        Some(map) => map,
        None => {
            // Header-less: the first row is data under the positional layout.
            let positional = positional_map();
            if let Some(host) = record_to_host(&first, &positional) {
                out.push(host);
            }
            positional
        }
    };

    for record in records {
        let record = record.map_err(|e| format!("parse inventory: {e}"))?;
        if let Some(host) = record_to_host(&record, &map) {
            out.push(host);
        }
    }
    Ok(out)
}

/// Parse the inventory file at `path` into [`InventoryHost`] rows.
pub fn parse_inventory_file(path: &Path) -> Result<Vec<InventoryHost>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_inventory_bytes(&bytes)
}

/// Parse the inventory file the user picked into importable hosts (#1961).
///
/// Unlike the SSH-config importer (which reads a fixed path and degrades a
/// missing file to an empty list), the user here explicitly picks a file, so a
/// read/parse failure surfaces as an error the UI can toast.
#[tauri::command]
pub fn import_inventory_hosts(path: String) -> Result<Vec<InventoryHost>, TerminalError> {
    parse_inventory_file(Path::new(&path)).map_err(TerminalError::EditorError)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> Vec<InventoryHost> {
        parse_inventory_bytes(input.as_bytes()).expect("parse inventory")
    }

    #[test]
    fn empty_input_yields_empty_list() {
        assert!(parse("").is_empty());
    }

    #[test]
    fn csv_with_header_maps_named_columns() {
        let rows = parse(
            "host,label,port,username\n\
             web1.internal,Web One,2022,alice\n\
             web2.internal,Web Two,,bob\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            InventoryHost {
                label: "Web One".into(),
                host: "web1.internal".into(),
                port: Some(2022),
                username: Some("alice".into()),
            }
        );
        // Empty port cell → no override.
        assert_eq!(rows[1].port, None);
        assert_eq!(rows[1].username.as_deref(), Some("bob"));
    }

    #[test]
    fn header_columns_can_be_reordered_and_aliased() {
        let rows = parse(
            "Username,Hostname,Port\n\
             carol,db.internal,5432\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].host, "db.internal");
        assert_eq!(rows[0].username.as_deref(), Some("carol"));
        assert_eq!(rows[0].port, Some(5432));
        // No label column → label falls back to the host.
        assert_eq!(rows[0].label, "db.internal");
    }

    #[test]
    fn unknown_header_columns_are_ignored() {
        let rows = parse(
            "host,os,rack\n\
             app.internal,linux,r12\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].host, "app.internal");
        assert_eq!(rows[0].port, None);
    }

    #[test]
    fn headerless_csv_uses_positional_layout() {
        let rows = parse(
            "10.0.0.1,gateway,22,root\n\
             10.0.0.2,switch\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].host, "10.0.0.1");
        assert_eq!(rows[0].label, "gateway");
        assert_eq!(rows[0].port, Some(22));
        assert_eq!(rows[0].username.as_deref(), Some("root"));
        // Second row: only host + label present.
        assert_eq!(rows[1].host, "10.0.0.2");
        assert_eq!(rows[1].label, "switch");
        assert_eq!(rows[1].port, None);
        assert_eq!(rows[1].username, None);
    }

    #[test]
    fn plain_host_per_line_list_labels_each_by_host() {
        let rows = parse("host-a\nhost-b\nhost-c\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].host, "host-a");
        assert_eq!(rows[0].label, "host-a");
        assert!(rows.iter().all(|r| r.port.is_none() && r.username.is_none()));
    }

    #[test]
    fn comment_and_blank_lines_are_skipped() {
        let rows = parse(
            "# fleet inventory\n\
             host,label\n\
             \n\
             web.internal,Web\n\
             # trailing comment\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].host, "web.internal");
    }

    #[test]
    fn rows_without_a_host_are_skipped() {
        let rows = parse(
            "host,label\n\
             ,Orphan Label\n\
             real.internal,Real\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].host, "real.internal");
    }

    #[test]
    fn malformed_port_degrades_to_no_override() {
        let rows = parse(
            "host,port\n\
             h.internal,notaport\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].port, None);
    }

    #[test]
    fn quoted_fields_with_commas_are_handled() {
        let rows = parse(
            "host,label\n\
             h.internal,\"Prod, East\"\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Prod, East");
    }

    #[test]
    fn whitespace_around_cells_is_trimmed() {
        let rows = parse(
            "host , label\n\
             \t spaced.internal \t, Spaced \n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].host, "spaced.internal");
        assert_eq!(rows[0].label, "Spaced");
    }

    #[test]
    fn missing_file_is_an_error() {
        let err = parse_inventory_file(Path::new("/nonexistent/does/not/exist.csv"));
        assert!(err.is_err());
    }
}
