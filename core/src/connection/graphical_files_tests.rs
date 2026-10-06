use super::*;

fn ssh(host: &str, target: &str) -> FileSideChannel {
    FileSideChannel {
        kind: FileSideChannelKind::Ssh,
        host: host.to_string(),
        user: "arne".to_string(),
        same_host: is_same_host(target, host),
    }
}

fn agent(host: &str, target: &str) -> FileSideChannel {
    FileSideChannel {
        kind: FileSideChannelKind::Agent,
        host: host.to_string(),
        user: "pi".to_string(),
        same_host: is_same_host(target, host),
    }
}

const ON: FileChannelPolicy = FileChannelPolicy {
    file_transfer: true,
    view_only: false,
};

#[test]
fn tunnel_to_loopback_is_the_desktop_host() {
    let channel = resolve_file_side_channel(ON, None, Some(ssh("tiger-box", "localhost"))).unwrap();
    assert_eq!(channel.kind, FileSideChannelKind::Ssh);
    assert_eq!(channel.host, "tiger-box");
    assert!(channel.same_host);
}

#[test]
fn tunnel_through_a_gateway_is_not_the_desktop_host() {
    let channel =
        resolve_file_side_channel(ON, None, Some(ssh("bastion.corp", "10.0.4.17"))).unwrap();
    assert_eq!(channel.kind, FileSideChannelKind::Ssh);
    assert_eq!(
        channel.host, "bastion.corp",
        "labels name the real file host"
    );
    assert!(!channel.same_host);
}

#[test]
fn agent_route_resolves_to_the_agent_host() {
    let channel = resolve_file_side_channel(ON, Some(agent("lab-pi", "127.0.0.1")), None).unwrap();
    assert_eq!(channel.kind, FileSideChannelKind::Agent);
    assert_eq!(channel.host, "lab-pi");
    assert!(channel.same_host);
}

#[test]
fn agent_wins_over_the_tunnel() {
    let channel = resolve_file_side_channel(
        ON,
        Some(agent("lab-pi", "localhost")),
        Some(ssh("tiger-box", "localhost")),
    )
    .unwrap();
    assert_eq!(channel.kind, FileSideChannelKind::Agent);
    assert_eq!(channel.host, "lab-pi");
}

#[test]
fn direct_connection_has_no_route() {
    assert_eq!(
        resolve_file_side_channel(ON, None, None),
        Err(FileChannelUnavailable::NoRoute)
    );
}

#[test]
fn view_only_is_refused_even_with_a_route() {
    let policy = FileChannelPolicy {
        file_transfer: true,
        view_only: true,
    };
    assert_eq!(
        resolve_file_side_channel(policy, None, Some(ssh("tiger-box", "localhost"))),
        Err(FileChannelUnavailable::ViewOnly)
    );
}

#[test]
fn setting_off_is_refused_even_with_a_route() {
    let policy = FileChannelPolicy {
        file_transfer: false,
        view_only: true,
    };
    assert_eq!(
        resolve_file_side_channel(policy, Some(agent("lab-pi", "localhost")), None),
        Err(FileChannelUnavailable::Disabled),
        "off is reported before view-only"
    );
}

#[test]
fn policy_reads_settings_and_defaults_off() {
    assert_eq!(
        FileChannelPolicy::from_settings(&serde_json::json!({})),
        FileChannelPolicy::default()
    );
    assert_eq!(
        FileChannelPolicy::from_settings(&serde_json::json!({
            "fileTransfer": true,
            "viewOnly": null,
        })),
        ON
    );
    let p = FileChannelPolicy::from_settings(&serde_json::json!({
        "fileTransfer": "yes",
        "viewOnly": true,
    }));
    assert!(!p.file_transfer, "a non-boolean is not an opt-in");
    assert!(p.view_only);
}

#[test]
fn loopback_names_and_addresses() {
    for host in [
        "localhost",
        "LOCALHOST",
        "localhost.",
        "vnc.localhost",
        "127.0.0.1",
        "127.1.2.3",
        "::1",
        "[::1]",
        " localhost ",
    ] {
        assert!(is_loopback_host(host), "{host} is loopback");
    }
    for host in ["", "10.0.4.17", "localhost.example.com", "::2", "tiger-box"] {
        assert!(!is_loopback_host(host), "{host} is not loopback");
    }
}

#[test]
fn same_name_target_counts_as_the_desktop_host() {
    assert!(is_same_host("Tiger-Box", "tiger-box"));
    assert!(is_same_host("tiger-box.", "tiger-box"));
    assert!(!is_same_host("office-pc", "bastion.corp"));
    assert!(!is_same_host("", "bastion.corp"));
}

#[test]
fn default_dir_prefers_the_configured_folder() {
    assert_eq!(
        default_dir(Some("~/Uploads"), "/home/arne", true),
        "/home/arne/Uploads"
    );
    assert_eq!(default_dir(Some("/srv/in"), "/home/arne", true), "/srv/in");
    assert_eq!(default_dir(Some("~"), "/home/arne", true), "/home/arne");
    assert_eq!(
        default_dir(Some("drop"), "/home/arne/", false),
        "/home/arne/drop"
    );
    assert_eq!(
        default_dir(Some("C:/Users/arne/in"), "/C:/Users/arne", true),
        "C:/Users/arne/in"
    );
}

#[test]
fn default_dir_falls_back_to_desktop_then_home() {
    assert_eq!(default_dir(None, "/home/arne", true), "/home/arne/Desktop");
    assert_eq!(
        default_dir(Some("  "), "/home/arne", true),
        "/home/arne/Desktop"
    );
    assert_eq!(default_dir(None, "/home/arne", false), "/home/arne");
    assert_eq!(default_dir(None, "/", true), "/Desktop");
}

#[test]
fn channel_serializes_camel_case() {
    let json = serde_json::to_value(ssh("tiger-box", "localhost")).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "kind": "ssh",
            "host": "tiger-box",
            "user": "arne",
            "sameHost": true,
        })
    );
    assert_eq!(
        serde_json::to_value(FileChannelUnavailable::ViewOnly).unwrap(),
        serde_json::json!("viewOnly")
    );
}
