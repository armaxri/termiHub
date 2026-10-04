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
