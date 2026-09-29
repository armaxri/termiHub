//! Open ports listing for Windows via the Win32 socket-owner tables (#3814).
//!
//! Reads `GetExtendedTcpTable` (listeners only) and `GetExtendedUdpTable` for
//! IPv4 and IPv6, then resolves owner PIDs to names with one Toolhelp process
//! snapshot. **No child process is spawned**: the previous `netstat -ano` +
//! one `tasklist` per socket spawned 50–200 console children per refresh, each
//! flashing a console window from the GUI-subsystem app.

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::{offset_of, size_of};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, INVALID_HANDLE_VALUE, NO_ERROR,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
    MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_UDP6ROW_OWNER_PID, MIB_UDP6TABLE_OWNER_PID,
    MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

use super::win_table::{
    build_open_ports, exe_name_from_wide, format_ipv4_endpoint, format_ipv6_endpoint,
    process_name_map, SocketRow,
};
use crate::network::error::NetworkError;
use crate::network::types::{OpenPort, Protocol};

/// `AF_INET` / `AF_INET6` as the `ulAf` argument of the table calls.
const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;

/// Retries when the table grows between the size query and the fetch.
const MAX_TABLE_ATTEMPTS: usize = 8;

pub fn list_open_ports() -> Result<Vec<OpenPort>, NetworkError> {
    let mut rows = Vec::new();

    let buf = fetch_table("TCP", |ptr, size| {
        // SAFETY: `ptr` is null or points at `*size` writable bytes.
        unsafe { GetExtendedTcpTable(ptr, size, 1, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) }
    })?;
    rows.extend(
        table_rows::<MIB_TCPROW_OWNER_PID>(&buf, offset_of!(MIB_TCPTABLE_OWNER_PID, table))
            .into_iter()
            .map(|r| SocketRow {
                protocol: Protocol::Tcp,
                local_addr: format_ipv4_endpoint(r.dwLocalAddr, r.dwLocalPort),
                pid: r.dwOwningPid,
            }),
    );

    let buf = fetch_table("TCP6", |ptr, size| {
        // SAFETY: as above.
        unsafe { GetExtendedTcpTable(ptr, size, 1, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0) }
    })?;
    rows.extend(
        table_rows::<MIB_TCP6ROW_OWNER_PID>(&buf, offset_of!(MIB_TCP6TABLE_OWNER_PID, table))
            .into_iter()
            .map(|r| SocketRow {
                protocol: Protocol::Tcp,
                local_addr: format_ipv6_endpoint(r.ucLocalAddr, r.dwLocalScopeId, r.dwLocalPort),
                pid: r.dwOwningPid,
            }),
    );

    let buf = fetch_table("UDP", |ptr, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(ptr, size, 1, AF_INET, UDP_TABLE_OWNER_PID, 0) }
    })?;
    rows.extend(
        table_rows::<MIB_UDPROW_OWNER_PID>(&buf, offset_of!(MIB_UDPTABLE_OWNER_PID, table))
            .into_iter()
            .map(|r| SocketRow {
                protocol: Protocol::Udp,
                local_addr: format_ipv4_endpoint(r.dwLocalAddr, r.dwLocalPort),
                pid: r.dwOwningPid,
            }),
    );

    let buf = fetch_table("UDP6", |ptr, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(ptr, size, 1, AF_INET6, UDP_TABLE_OWNER_PID, 0) }
    })?;
    rows.extend(
        table_rows::<MIB_UDP6ROW_OWNER_PID>(&buf, offset_of!(MIB_UDP6TABLE_OWNER_PID, table))
            .into_iter()
            .map(|r| SocketRow {
                protocol: Protocol::Udp,
                local_addr: format_ipv6_endpoint(r.ucLocalAddr, r.dwLocalScopeId, r.dwLocalPort),
                pid: r.dwOwningPid,
            }),
    );

    Ok(build_open_ports(rows, &process_names()))
}

/// Run a `GetExtended*Table` call with the size-query / fetch protocol,
/// retrying while the table grows. Returns the raw table bytes.
fn fetch_table<F>(label: &str, call: F) -> Result<Vec<u8>, NetworkError>
where
    F: Fn(*mut c_void, *mut u32) -> u32,
{
    let mut size: u32 = 0;
    for _ in 0..MAX_TABLE_ATTEMPTS {
        let mut buf = vec![0u8; size as usize];
        let ptr = if buf.is_empty() {
            std::ptr::null_mut()
        } else {
            buf.as_mut_ptr().cast::<c_void>()
        };
        match call(ptr, &mut size) {
            NO_ERROR => return Ok(buf),
            ERROR_INSUFFICIENT_BUFFER => continue,
            code => {
                return Err(NetworkError::Platform(format!(
                    "{label} socket table query failed (error {code})"
                )))
            }
        }
    }
    Err(NetworkError::Platform(format!(
        "{label} socket table kept growing; giving up"
    )))
}

/// Read the rows of a `{ dwNumEntries: u32, table: [R; N] }` buffer whose
/// `table` field starts at `table_offset`. Rows past the buffer end are
/// ignored, so a short buffer can never be over-read.
fn table_rows<R: Copy>(buf: &[u8], table_offset: usize) -> Vec<R> {
    let Some(count_bytes) = buf.get(..4) else {
        return Vec::new();
    };
    let mut count = [0u8; 4];
    count.copy_from_slice(count_bytes);
    let declared = u32::from_ne_bytes(count) as usize;
    let fits = buf.len().saturating_sub(table_offset) / size_of::<R>();
    (0..declared.min(fits))
        .map(|i| {
            let start = table_offset + i * size_of::<R>();
            // SAFETY: `start + size_of::<R>() <= buf.len()` by the `fits`
            // bound; the rows are plain-old-data, read unaligned from a
            // byte buffer.
            unsafe { std::ptr::read_unaligned(buf.as_ptr().add(start).cast::<R>()) }
        })
        .collect()
}

/// PID → display name for every running process, from one Toolhelp snapshot.
/// Best-effort: an empty map (names shown as unknown) if the snapshot fails.
fn process_names() -> HashMap<u32, String> {
    let mut entries = Vec::new();
    // SAFETY: plain snapshot of the process list; the handle is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
        return HashMap::new();
    }
    // SAFETY: PROCESSENTRY32W is plain-old-data; all-zero is a valid value.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: `snapshot` is a valid snapshot handle and `entry.dwSize` is set.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        entries.push((entry.th32ProcessID, exe_name_from_wide(&entry.szExeFile)));
        // SAFETY: as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: `snapshot` is a handle we own and close exactly once.
    unsafe { CloseHandle(snapshot) };
    process_name_map(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real tables are readable on the Windows CI runner and list at least
    /// the RPC endpoint mapper every Windows host listens on, with a name.
    #[test]
    fn lists_real_listeners_without_spawning() {
        let ports = list_open_ports().expect("list open ports");
        assert!(!ports.is_empty(), "a Windows host always has listeners");
        assert!(ports.iter().all(|p| p.pid.is_some()));
        assert!(
            ports.iter().any(|p| p.process.is_some()),
            "at least one owner PID resolves to a name: {ports:?}"
        );
    }

    #[test]
    fn table_rows_never_over_reads_a_short_buffer() {
        // Declares 5 rows but only carries one full 12-byte UDP row.
        let mut buf = 5u32.to_ne_bytes().to_vec();
        buf.extend_from_slice(&[0u8; 12 + 3]);
        let rows = table_rows::<MIB_UDPROW_OWNER_PID>(&buf, 4);
        assert_eq!(rows.len(), 1);
        assert!(table_rows::<MIB_UDPROW_OWNER_PID>(&[1, 0], 4).is_empty());
    }
}
