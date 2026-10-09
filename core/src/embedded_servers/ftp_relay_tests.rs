//! Unit tests for the FTP front relay's framing and reply handling (#3996).

use super::*;

#[test]
fn framer_splits_lines_across_chunks() {
    let mut framer = LineFramer::new(16);
    assert_eq!(framer.push(b"USER al").unwrap(), Vec::<Vec<u8>>::new());
    assert_eq!(framer.pending_len(), 7);
    let lines = framer.push(b"ice\r\nPASS x\r\nNO").unwrap();
    assert_eq!(
        lines,
        vec![b"USER alice\r\n".to_vec(), b"PASS x\r\n".to_vec()]
    );
    assert_eq!(framer.pending_len(), 2);
}

#[test]
fn framer_accepts_a_line_exactly_at_the_cap() {
    let mut framer = LineFramer::new(8);
    let lines = framer.push(b"1234567\r\n").unwrap();
    assert_eq!(lines, vec![b"1234567\r\n".to_vec()]);
}

#[test]
fn framer_rejects_a_complete_line_over_the_cap() {
    let mut framer = LineFramer::new(8);
    assert_eq!(framer.push(b"123456789\n"), Err(LineTooLong));
}

/// Memory stays bounded: an unterminated line fails as soon as it passes the
/// cap, and the framer never holds more than the cap.
#[test]
fn framer_never_holds_more_than_the_cap() {
    let mut framer = LineFramer::new(MAX_CONTROL_LINE);
    let chunk = [b'A'; READ_CHUNK];
    let mut fed = 0usize;
    let result = loop {
        match framer.push(&chunk) {
            Ok(lines) => {
                assert!(lines.is_empty());
                assert!(framer.pending_len() <= MAX_CONTROL_LINE);
                fed += chunk.len();
                assert!(fed <= MAX_CONTROL_LINE, "accepted {fed} bytes past the cap");
            }
            Err(e) => break e,
        }
    };
    assert_eq!(result, LineTooLong);
    assert!(framer.pending_len() <= MAX_CONTROL_LINE);
}

#[test]
fn proxy_header_carries_client_and_destination() {
    let header = proxy_v1_header(
        "198.51.100.4:51000".parse().unwrap(),
        "192.0.2.1:2121".parse().unwrap(),
    );
    assert_eq!(header, "PROXY TCP4 198.51.100.4 192.0.2.1 51000 2121\r\n");
}

#[test]
fn proxy_header_unmaps_ipv4_mapped_and_placeholders_ipv6() {
    let header = proxy_v1_header(
        "[::ffff:198.51.100.4]:51000".parse().unwrap(),
        "[2001:db8::1]:2121".parse().unwrap(),
    );
    assert_eq!(header, "PROXY TCP4 198.51.100.4 0.0.0.0 51000 2121\r\n");
}

#[test]
fn pasv_reply_round_trips() {
    let reply = pasv_reply(Ipv4Addr::new(192, 0, 2, 1), 50_001);
    assert_eq!(
        reply,
        b"227 Entering Passive Mode (192,0,2,1,195,81)\r\n".to_vec()
    );
    assert_eq!(parse_pasv_port(&reply), Some(50_001));
}

#[test]
fn pasv_parse_rejects_malformed_replies() {
    assert_eq!(parse_pasv_port(b"227 Entering Passive Mode\r\n"), None);
    assert_eq!(parse_pasv_port(b"227 (1,2,3,4,5)\r\n"), None);
    assert_eq!(parse_pasv_port(b"227 (1,2,3,4,5,999)\r\n"), None);
    assert_eq!(parse_pasv_port(b"200 (1,2,3,4,5,6)\r\n"), None);
}

#[test]
fn epsv_reply_format() {
    assert_eq!(
        epsv_reply(50_001),
        b"229 Entering Extended Passive Mode (|||50001|)\r\n".to_vec()
    );
}

#[test]
fn epsv_requests_are_recognised() {
    assert!(is_epsv_request(b"EPSV\r\n"));
    assert!(is_epsv_request(b"epsv\n"));
    assert!(is_epsv_request(b"EPSV 1\r\n"));
    assert!(is_epsv_request(b"EPSV 2\r\n"));
    assert!(!is_epsv_request(b"EPSV ALL\r\n"));
    assert!(!is_epsv_request(b"PASV\r\n"));
    assert!(!is_epsv_request(b"EPSVX\r\n"));
}

#[test]
fn reply_tracker_finds_final_lines_of_multiline_replies() {
    let mut tracker = ReplyTracker::default();
    assert_eq!(tracker.final_code(b"211-Features:\r\n"), None);
    assert_eq!(tracker.final_code(b" EPSV\r\n"), None);
    assert_eq!(tracker.final_code(b"227 not the end\r\n"), None);
    assert_eq!(tracker.final_code(b"211 End\r\n"), Some(211));
    assert_eq!(tracker.final_code(b"150 Opening\r\n"), Some(150));
    assert_eq!(tracker.final_code(b"226 Done\r\n"), Some(226));
}

#[test]
fn data_listener_prefers_the_reserved_port_and_falls_back_in_range() {
    let ip: IpAddr = Ipv4Addr::LOCALHOST.into();
    // Find a free port with a free neighbour, hold it, and expect the next one.
    let holder = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let held = holder.local_addr().unwrap().port();
    let range = held..=held.saturating_add(DATA_BIND_ATTEMPTS as u16);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let listener = bind_data_listener(ip, held, &range).expect("fallback port");
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, held, "the held port cannot be reused");
        assert!(range.contains(&port), "{port} in {range:?}");
    });
}

/// Regression for #4563: the fallbacks must not be a run of adjacent ports.
/// On Windows the passive range is the OS dynamic range, where Hyper-V/WinNAT
/// exclude whole ~100-port blocks; probing the 64 ports after a reserved port
/// inside such a block answered `425` to `PASV`.
#[test]
fn data_listener_fallbacks_are_distinct_in_range_and_spread_out() {
    let range = 49152..=65534u16;
    for preferred in [*range.start(), 50000, 57343, 65000, *range.end()] {
        let ports: Vec<u16> = fallback_ports(preferred, &range).collect();
        assert_eq!(ports.len(), DATA_BIND_ATTEMPTS as usize, "{preferred}");
        let unique: std::collections::HashSet<u16> = ports.iter().copied().collect();
        assert_eq!(unique.len(), ports.len(), "distinct for {preferred}");
        assert!(
            !unique.contains(&preferred),
            "preferred is tried separately"
        );
        assert!(ports.iter().all(|p| range.contains(p)), "{ports:?}");
        // At most two candidates fall in any 128-port block (an excluded
        // block is ~100 ports), so a blocked neighbourhood costs two tries.
        let mut per_block = std::collections::HashMap::new();
        for p in &ports {
            *per_block.entry(p / 128).or_insert(0u32) += 1;
        }
        assert!(
            per_block.values().all(|&n| n <= 2),
            "clustered fallbacks for {preferred}: {ports:?}"
        );
        // The first fallback already leaves the preferred port's block.
        assert!(
            ports[0].abs_diff(preferred) > 128,
            "{preferred} -> {}",
            ports[0]
        );
    }
}

#[test]
fn data_listener_fallbacks_cover_small_ranges_without_repeats() {
    for size in [1u16, 2, 3, 10, 64, 65, 100] {
        let range = 50000..=50000 + size - 1;
        let ports: Vec<u16> = fallback_ports(50000, &range).collect();
        let expected = (DATA_BIND_ATTEMPTS as usize).min(usize::from(size) - 1);
        assert_eq!(ports.len(), expected, "size {size}");
        let unique: std::collections::HashSet<u16> = ports.iter().copied().collect();
        assert_eq!(unique.len(), ports.len(), "size {size}: {ports:?}");
        assert!(!unique.contains(&50000));
        assert!(ports.iter().all(|p| range.contains(p)));
    }
}
