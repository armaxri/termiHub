//! DNS lookup using `hickory-resolver`.

use std::time::Instant;

use hickory_resolver::config::{
    NameServerConfig, NameServerConfigGroup, Protocol as DnsProtocol, ResolverConfig, ResolverOpts,
};
use hickory_resolver::proto::rr::RecordType;
use hickory_resolver::TokioAsyncResolver;

use super::error::NetworkError;
use super::types::{DnsRecord, DnsRecordType, DnsResult};

/// Look up DNS records for `hostname`.
///
/// * `record_type` – The record type to query.
/// * `server` – Optional custom nameserver IP (e.g. `"8.8.8.8"`). Pass `None`
///   to use the system resolver.
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

    for record in lookup.record_iter() {
        if let Some(value) = format_rdata(record.data()) {
            records.push(DnsRecord {
                record_type: record_type_from_hickory(record.record_type()),
                name: record.name().to_utf8(),
                value,
                ttl: record.ttl(),
            });
        }
    }

    Ok(DnsResult { records, query_ms })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn build_resolver(server: Option<&str>) -> Result<TokioAsyncResolver, NetworkError> {
    if let Some(ip_str) = server {
        let ip: std::net::IpAddr = ip_str.parse().map_err(|_| {
            NetworkError::InvalidParameter(format!("invalid DNS server IP: '{ip_str}'"))
        })?;

        let ns = NameServerConfig::new(std::net::SocketAddr::new(ip, 53), DnsProtocol::Udp);
        let ns_group = NameServerConfigGroup::from(vec![ns]);
        let config = ResolverConfig::from_parts(None, vec![], ns_group);
        Ok(TokioAsyncResolver::tokio(config, ResolverOpts::default()))
    } else {
        TokioAsyncResolver::tokio_from_system_conf()
            .map_err(|e| NetworkError::Platform(e.to_string()))
    }
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

fn format_rdata(data: Option<&hickory_resolver::proto::rr::RData>) -> Option<String> {
    use hickory_resolver::proto::rr::RData;
    Some(match data? {
        RData::A(ip) => ip.to_string(),
        RData::AAAA(ip) => ip.to_string(),
        RData::CNAME(name) => name.to_utf8(),
        RData::NS(name) => name.to_utf8(),
        RData::PTR(name) => name.to_utf8(),
        RData::MX(mx) => format!("{} {}", mx.preference(), mx.exchange().to_utf8()),
        RData::TXT(txt) => txt
            .iter()
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .collect::<Vec<_>>()
            .join(" "),
        RData::SRV(srv) => format!(
            "{} {} {} {}",
            srv.priority(),
            srv.weight(),
            srv.port(),
            srv.target().to_utf8()
        ),
        RData::SOA(soa) => format!(
            "{} {} {} {} {} {} {}",
            soa.mname().to_utf8(),
            soa.rname().to_utf8(),
            soa.serial(),
            soa.refresh(),
            soa.retry(),
            soa.expire(),
            soa.minimum()
        ),
        other => format!("{other:?}"),
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
}
