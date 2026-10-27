//! Tests for [`CwdFollower`] and [`osc7`] (#5009).

use super::*;

fn at(ms: u64) -> Instant {
    static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *ORIGIN.get_or_init(Instant::now) + Duration::from_millis(ms)
}

const MIN: Duration = Duration::from_millis(500);

#[test]
fn first_prompt_is_read_once_settled() {
    let mut f = CwdFollower::new(MIN);
    assert_eq!(f.next_read(), None, "nothing before any output");
    f.observe(b"motd\r\n$ ", at(0));
    assert_eq!(f.next_read(), Some(at(0) + SETTLE));
    assert!(!f.start_read(at(100)), "not settled yet");
    assert!(f.start_read(at(150)));
    assert_eq!(
        f.finish_read(Some("/home/me")),
        Some(b"\x1b]7;file:///home/me\x07".to_vec())
    );
}

#[test]
fn typing_at_the_prompt_never_reads() {
    let mut f = CwdFollower::new(MIN);
    f.observe(b"$ ", at(0));
    assert!(f.start_read(at(200)));
    f.finish_read(Some("/home/me"));
    for (i, key) in [b"c", b"d", b" "].iter().enumerate() {
        f.observe(*key, at(1000 + i as u64 * 300));
    }
    assert_eq!(f.next_read(), None, "no line break, no read");
}

#[test]
fn a_command_triggers_a_read_and_only_a_change_is_reported() {
    let mut f = CwdFollower::new(MIN);
    f.observe(b"$ ", at(0));
    assert!(f.start_read(at(200)));
    assert!(f.finish_read(Some("/home/me")).is_some());
    f.observe(b"ls\r\nfile\r\n$ ", at(1000));
    assert!(f.start_read(at(1200)));
    assert_eq!(f.finish_read(Some("/home/me")), None, "unchanged");
    f.observe(b"cd /tmp\r\n$ ", at(2000));
    assert!(f.start_read(at(2200)));
    assert_eq!(f.finish_read(Some("/tmp")), Some(osc7("/tmp")));
}

#[test]
fn reads_are_rate_limited() {
    let mut f = CwdFollower::new(MIN);
    f.observe(b"$ ", at(0));
    assert!(f.start_read(at(150)));
    f.finish_read(Some("/a"));
    f.observe(b"x\r\n$ ", at(200));
    assert_eq!(f.next_read(), Some(at(150) + MIN));
}

#[test]
fn a_running_read_is_not_started_twice() {
    let mut f = CwdFollower::new(MIN);
    f.observe(b"$ ", at(0));
    assert!(f.start_read(at(200)));
    f.observe(b"x\r\n$ ", at(300));
    assert_eq!(f.next_read(), None);
    assert!(!f.start_read(at(5000)));
}

#[test]
fn a_shell_that_reports_its_cwd_turns_the_follower_off() {
    for report in [&b"\x1b]7;file://host/x\x07"[..], b"\x1b]9;9;C:\\x\x1b\\"] {
        let mut f = CwdFollower::new(MIN);
        // Split across two chunks.
        let (a, b) = report.split_at(3);
        f.observe(a, at(0));
        f.observe(b, at(1));
        f.observe(b"\r\n$ ", at(2));
        assert!(f.shell_reports_cwd());
        assert_eq!(f.next_read(), None);
        assert_eq!(f.finish_read(Some("/y")), None);
    }
}

#[test]
fn a_report_waits_until_the_stream_leaves_an_escape_sequence() {
    let mut f = CwdFollower::new(MIN);
    f.observe(b"$ \r\n\x1b[38;5", at(0));
    assert!(f.start_read(at(200)));
    assert_eq!(f.finish_read(Some("/a")), None, "mid CSI: held");
    f.observe(b";1m", at(300));
    assert_eq!(f.take_pending(), Some(osc7("/a")));
    assert_eq!(f.take_pending(), None);
}

#[test]
fn an_unreadable_cwd_reports_nothing() {
    let mut f = CwdFollower::new(MIN);
    f.observe(b"$ ", at(0));
    assert!(f.start_read(at(200)));
    assert_eq!(f.finish_read(None), None);
    assert_eq!(f.finish_read(Some("")), None);
}

#[test]
fn osc7_encodes_paths_the_terminal_parser_reads_back() {
    assert_eq!(osc7("/a b/ü#1"), b"\x1b]7;file:///a%20b/%C3%BC%231\x07");
    assert_eq!(osc7(r"C:\Users\me"), b"\x1b]7;file:///C:/Users/me\x07");
}
