//! DNS lookup using `hickory-resolver`.

use std::net::{IpAddr, SocketAddr};
use std::time::Instant;

use hickory_resolver::config::{NameServerConfig, ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::RecordType;
use hickory_resolver::TokioResolver;

use super::error::NetworkError;
use super::types::{DnsRecord, DnsRecordType, DnsResult};

/// Look up DNS records for `hostname`.
///
/// * `record_type` – The record type to query.
/// * `server` – Optional custom nameserver: an IP (e.g. `"8.8.8.8"`, queried on
///   port 53) or an `ip:port` / `[ipv6]:port` socket address (e.g.
///   `"127.0.0.1:5353"`) for a resolver on a non-standard port. Pass `None` to
///   use the system resolver.
pub async fn dns_lookup(
    hostname: &str,
    record_type: DnsRecordType,
    server: Option<&str>,
) -> Result<DnsResult, NetworkError> {
    let resolver = build_resolver(server)?;
    let rtype = to_hickory_type(&record_type);

    let started = Instant::now();
    let lookup =
        resolver
            .lookup(hostname, rtype)
            .await
            .map_err(|e| NetworkError::DnsResolution {
                host: hostname.to_string(),
                reason: e.to_string(),
            })?;

    let query_ms = started.elapsed().as_millis() as u64;
    let mut records = Vec::new();

    for record in lookup.answers() {
        if let Some(value) = format_rdata(&record.data) {
            records.push(DnsRecord {
                record_type: record_type_from_hickory(record.record_type()),
                name: record.name.to_utf8(),
                value,
                ttl: record.ttl,
            });
        }
    }

    Ok(DnsResult { records, query_ms })
}

/// Best-effort reverse-DNS (PTR) lookup for an IP address.
///
/// Returns the first resolved hostname (with the trailing root dot trimmed), or
/// `None` if the address has no PTR record or the system resolver is
/// unavailable. Never errors — reverse resolution is advisory (e.g. the NAME
/// column of the ping sweep), so a failure simply means "no name".
pub async fn reverse_lookup(ip: std::net::IpAddr) -> Option<String> {
    use hickory_resolver::proto::rr::RData;
    let resolver = build_resolver(None).ok()?;
    let lookup = resolver.reverse_lookup(ip).await.ok()?;
    lookup.answers().iter().find_map(|record| {
        if let RData::PTR(name) = &record.data {
            let s = name.to_utf8();
            Some(s.strip_suffix('.').unwrap_or(&s).to_string())
        } else {
            None
        }
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn build_resolver(server: Option<&str>) -> Result<TokioResolver, NetworkError> {
    if let Some(server_str) = server {
        let addr = parse_server(server_str)?;
        let mut name_server = NameServerConfig::udp(addr.ip());
        for conn in &mut name_server.connections {
            conn.port = addr.port();
        }

        let config = ResolverConfig::from_parts(None, vec![], vec![name_server]);
        TokioResolver::builder_with_config(config, TokioRuntimeProvider::default())
            .with_options(ResolverOpts::default())
            .build()
            .map_err(|e| NetworkError::Platform(e.to_string()))
    } else {
        TokioResolver::builder_tokio()
            .map_err(|e| NetworkError::Platform(e.to_string()))?
            .build()
            .map_err(|e| NetworkError::Platform(e.to_string()))
    }
}

/// Default DNS port, used when the custom server is given as a bare IP.
const DNS_PORT: u16 = 53;

/// Parse a custom nameserver: a bare IP (port 53) or an `ip:port` /
/// `[ipv6]:port` socket address.
fn parse_server(server: &str) -> Result<SocketAddr, NetworkError> {
    let trimmed = server.trim();
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, DNS_PORT));
    }
    trimmed.parse::<SocketAddr>().map_err(|_| {
        NetworkError::InvalidParameter(format!(
            "invalid DNS server: '{server}' (expected an IP or ip:port)"
        ))
    })
}

fn to_hickory_type(rt: &DnsRecordType) -> RecordType {
    match rt {
        DnsRecordType::A => RecordType::A,
        DnsRecordType::Aaaa => RecordType::AAAA,
        DnsRecordType::Mx => RecordType::MX,
        DnsRecordType::Cname => RecordType::CNAME,
        DnsRecordType::Ns => RecordType::NS,
        DnsRecordType::Txt => RecordType::TXT,
        DnsRecordType::Srv => RecordType::SRV,
        DnsRecordType::Soa => RecordType::SOA,
        DnsRecordType::Ptr => RecordType::PTR,
        DnsRecordType::Any => RecordType::ANY,
    }
}

fn record_type_from_hickory(rt: RecordType) -> DnsRecordType {
    match rt {
        RecordType::A => DnsRecordType::A,
        RecordType::AAAA => DnsRecordType::Aaaa,
        RecordType::MX => DnsRecordType::Mx,
        RecordType::CNAME => DnsRecordType::Cname,
        RecordType::NS => DnsRecordType::Ns,
        RecordType::TXT => DnsRecordType::Txt,
        RecordType::SRV => DnsRecordType::Srv,
        RecordType::SOA => DnsRecordType::Soa,
        RecordType::PTR => DnsRecordType::Ptr,
        _ => DnsRecordType::Any,
    }
}

fn format_rdata(data: &hickory_resolver::proto::rr::RData) -> Option<String> {
    use hickory_resolver::proto::rr::RData;
    Some(match data {
        RData::A(ip) => ip.to_string(),
        RData::AAAA(ip) => ip.to_string(),
        RData::CNAME(name) => name.to_utf8(),
        RData::NS(name) => name.to_utf8(),
        RData::PTR(name) => name.to_utf8(),
        RData::MX(mx) => format!("{} {}", mx.preference, mx.exchange.to_utf8()),
        RData::TXT(txt) => txt
            .txt_data
            .iter()
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .collect::<Vec<_>>()
            .join(" "),
        RData::SRV(srv) => format!(
            "{} {} {} {}",
            srv.priority,
            srv.weight,
            srv.port,
            srv.target.to_utf8()
        ),
        RData::SOA(soa) => format!(
            "{} {} {} {} {} {} {}",
            soa.mname.to_utf8(),
            soa.rname.to_utf8(),
            soa.serial,
            soa.refresh,
            soa.retry,
            soa.expire,
            soa.minimum
        ),
        other => return Some(format!("{other:?}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_record_type_roundtrip() {
        let types = [
            DnsRecordType::A,
            DnsRecordType::Aaaa,
            DnsRecordType::Mx,
            DnsRecordType::Cname,
            DnsRecordType::Ns,
            DnsRecordType::Txt,
        ];
        for rt in &types {
            let hickory = to_hickory_type(rt);
            let back = record_type_from_hickory(hickory);
            assert_eq!(*rt, back, "roundtrip failed for {rt:?}");
        }
    }

    #[test]
    fn lookup_invalid_server_ip() {
        let result = build_resolver(Some("not-an-ip"));
        assert!(result.is_err());
        assert!(matches!(result, Err(NetworkError::InvalidParameter(_))));
    }

    #[test]
    fn parse_server_accepts_bare_ip_and_socket_addr() {
        assert_eq!(
            parse_server("8.8.8.8").unwrap(),
            "8.8.8.8:53".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            parse_server(" ::1 ").unwrap(),
            "[::1]:53".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            parse_server("127.0.0.1:5353").unwrap(),
            "127.0.0.1:5353".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            parse_server("[::1]:5353").unwrap(),
            "[::1]:5353".parse::<SocketAddr>().unwrap()
        );
        for bad in ["", "dns.example", "1.2.3.4:", "1.2.3.4:99999", "::1:53x"] {
            assert!(
                matches!(parse_server(bad), Err(NetworkError::InvalidParameter(_))),
                "{bad:?} must be rejected"
            );
        }
    }

    /// In-process stub DNS server (MT-NET-15, #3692): a UDP responder on a free
    /// loopback port serving fixed MX/CNAME/NS/TXT records for one zone, so the
    /// real `dns_lookup` path (hickory resolver → wire → parse → format) is
    /// graded deterministically, with no network and no privileged port.
    mod stub {
        use hickory_resolver::proto::op::{Message, MessageType, ResponseCode};
        use hickory_resolver::proto::rr::rdata::{CNAME, MX, NS, TXT};
        use hickory_resolver::proto::rr::{Name, RData, Record, RecordType};
        use tokio::net::UdpSocket;

        pub const ZONE: &str = "stub.termihub.test.";
        pub const TTL: u32 = 300;

        fn name(s: &str) -> Name {
            Name::from_ascii(s).expect("valid stub name")
        }

        /// The fixed answers for `(qname, qtype)`; empty → NXDOMAIN-free empty
        /// answer (NOERROR/NODATA).
        fn answers(qname: &Name, qtype: RecordType) -> Vec<Record> {
            let zone = name(ZONE);
            let alias = name(&format!("www.{ZONE}"));
            let rdata: Vec<(Name, RData)> = match qtype {
                RecordType::MX if *qname == zone => vec![
                    (
                        zone.clone(),
                        RData::MX(MX::new(10, name(&format!("mx1.{ZONE}")))),
                    ),
                    (
                        zone.clone(),
                        RData::MX(MX::new(20, name(&format!("mx2.{ZONE}")))),
                    ),
                ],
                RecordType::NS if *qname == zone => vec![
                    (zone.clone(), RData::NS(NS(name(&format!("ns1.{ZONE}"))))),
                    (zone.clone(), RData::NS(NS(name(&format!("ns2.{ZONE}"))))),
                ],
                RecordType::TXT if *qname == zone => vec![(
                    zone.clone(),
                    RData::TXT(TXT::new(vec!["v=spf1 -all".to_string()])),
                )],
                RecordType::CNAME if *qname == alias => vec![(
                    alias.clone(),
                    RData::CNAME(CNAME(name(&format!("target.{ZONE}")))),
                )],
                _ => vec![],
            };
            rdata
                .into_iter()
                .map(|(n, d)| Record::from_rdata(n, TTL, d))
                .collect()
        }

        /// Bind the stub on `127.0.0.1:0` and serve until the test's runtime
        /// drops. Returns the bound address (`ip:port`) for `dns_lookup`.
        pub async fn spawn() -> std::net::SocketAddr {
            let socket = UdpSocket::bind("127.0.0.1:0").await.expect("bind stub");
            let addr = socket.local_addr().expect("stub addr");
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                loop {
                    let Ok((len, peer)) = socket.recv_from(&mut buf).await else {
                        return;
                    };
                    let Ok(query) = Message::from_vec(&buf[..len]) else {
                        continue;
                    };
                    let mut reply = Message::response(query.metadata.id, query.metadata.op_code);
                    reply.metadata.message_type = MessageType::Response;
                    reply.metadata.authoritative = true;
                    reply.metadata.recursion_desired = query.metadata.recursion_desired;
                    reply.metadata.recursion_available = true;
                    reply.metadata.response_code = ResponseCode::NoError;
                    for q in &query.queries {
                        reply.add_query(q.clone());
                        reply.add_answers(answers(&q.name, q.query_type));
                    }
                    if let Ok(bytes) = reply.to_vec() {
                        let _ = socket.send_to(&bytes, peer).await;
                    }
                }
            });
            addr
        }
    }

    async fn stub_lookup(host: &str, rt: DnsRecordType) -> DnsResult {
        let addr = stub::spawn().await;
        dns_lookup(host, rt.clone(), Some(&addr.to_string()))
            .await
            .unwrap_or_else(|e| panic!("{rt:?} lookup of {host} via stub {addr}: {e}"))
    }

    fn values(result: &DnsResult, rt: DnsRecordType) -> Vec<String> {
        let mut v: Vec<String> = result
            .records
            .iter()
            .inspect(|r| {
                assert_eq!(r.record_type, rt, "record type: {r:?}");
                assert_eq!(r.ttl, stub::TTL, "ttl: {r:?}");
            })
            .map(|r| r.value.clone())
            .collect();
        v.sort();
        v
    }

    #[tokio::test]
    async fn stub_server_mx_records() {
        let result = stub_lookup(stub::ZONE, DnsRecordType::Mx).await;
        assert_eq!(
            values(&result, DnsRecordType::Mx),
            vec![
                "10 mx1.stub.termihub.test.".to_string(),
                "20 mx2.stub.termihub.test.".to_string()
            ]
        );
        assert!(result.records.iter().all(|r| r.name == stub::ZONE));
    }

    #[tokio::test]
    async fn stub_server_cname_record() {
        let alias = format!("www.{}", stub::ZONE);
        let result = stub_lookup(&alias, DnsRecordType::Cname).await;
        assert_eq!(
            values(&result, DnsRecordType::Cname),
            vec!["target.stub.termihub.test.".to_string()]
        );
        assert_eq!(result.records[0].name, alias);
    }

    #[tokio::test]
    async fn stub_server_ns_records() {
        let result = stub_lookup(stub::ZONE, DnsRecordType::Ns).await;
        assert_eq!(
            values(&result, DnsRecordType::Ns),
            vec![
                "ns1.stub.termihub.test.".to_string(),
                "ns2.stub.termihub.test.".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn stub_server_txt_record() {
        let result = stub_lookup(stub::ZONE, DnsRecordType::Txt).await;
        assert_eq!(
            values(&result, DnsRecordType::Txt),
            vec!["v=spf1 -all".to_string()]
        );
    }
}
