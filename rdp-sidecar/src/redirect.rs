//! Following an RDP Server Redirection (MS-RDPBCGR 2.2.13, #5137).
//!
//! A connection broker or load balancer answers a new connection with a
//! Server Redirection PDU naming the server (and session) the client must
//! reconnect to. IronRDP reports it at three points, all routed here: during
//! the connection sequence (`ConnectionOutcome::Redirected`), during a
//! reactivation (`ConnectionActivationState::Redirected`) and mid-session
//! (`ActiveStageOutput::ServerRedirection`).
//!
//! The sidecar follows a redirection, guarded (maintainer decision on #5137):
//!
//! - **At most [`MAX_REDIRECT_HOPS`] hops**, and never to a target it already
//!   visited with the same routing token and session ([`HopGuard`]). A fourth
//!   redirect or a loop ends the session with a typed [`RedirectRefused`].
//! - **The new server passes the certificate trust gate first** (#1758 /
//!   #1767). A server the sidecar has not yet dialled is *preflighted*: TCP,
//!   an X.224 request carrying no client data (no username cookie, no routing
//!   token), TLS, then the trust gate, exactly as for a first connect
//!   ([`admit`]). Only then does the real connect send the routing token, the
//!   Client Info (username, domain, password cookie) and the CredSSP exchange.
//!   The real connect gates the certificate again, unless it is the one just
//!   accepted in the preflight.
//! - **A redirection back to the issuing server** (no target address, only a
//!   routing token: "revectoring", MS-RDPBCGR 1.3.8) returns the token to the
//!   server that issued it, whose certificate was already gated; the
//!   certificate the reconnect then meets is gated before any credentials go
//!   out.
//!
//! The redirection's username, domain and password cookie replace the saved
//! ones when present; a PK-encrypted password (RDSTLS, which IronRDP's
//! connector does not speak) is ignored and the saved password authenticates.

use std::collections::HashSet;
use std::fmt;

use anyhow::{anyhow, Result};
use ironrdp_pdu::nego::MAX_ROUTING_TOKEN_LENGTH;
use ironrdp_pdu::rdp::server_redirection::{ServerRedirectionFlags, ServerRedirectionPdu};
use tracing::{debug, warn};

/// How many redirections one sidecar session follows before giving up. A
/// broker → session host chain is one hop; three leaves room for a gateway
/// or a second broker tier without letting a misconfigured farm spin.
pub const MAX_REDIRECT_HOPS: usize = 3;

/// A server one connect dials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// The addresses to dial, in order; the first that answers wins.
    pub addresses: Vec<String>,
    /// The name TLS SNI and the CredSSP service principal use, and the name
    /// the host keys its certificate trust store on.
    pub server_name: String,
}

/// Where and how to reconnect after a Server Redirection.
#[derive(Clone)]
pub struct Redirect {
    /// The target server.
    pub endpoint: Endpoint,
    /// The target is the server that issued the redirection (revectoring):
    /// its identity was already gated, so it needs no preflight.
    pub back_to_issuer: bool,
    /// The session to reconnect to (Client Cluster Data `RedirectedSessionID`).
    pub session_id: u32,
    /// The broker's `LoadBalanceInfo`, sent back as the X.224 routing token.
    pub routing_token: Option<String>,
    /// The username the target expects, replacing the saved one.
    pub username: Option<String>,
    /// The domain the target expects, replacing the saved one.
    pub domain: Option<String>,
    /// The cleartext password cookie for the target's Client Info PDU.
    pub password_cookie: Option<Vec<u8>>,
}

impl fmt::Debug for Redirect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The password cookie is a credential; the routing token is opaque
        // load-balancing data and stays out of logs as well.
        f.debug_struct("Redirect")
            .field("endpoint", &self.endpoint)
            .field("back_to_issuer", &self.back_to_issuer)
            .field("session_id", &self.session_id)
            .field("routing_token", &self.routing_token.is_some())
            .field("username", &self.username)
            .field("domain", &self.domain)
            .field("password_cookie", &self.password_cookie.is_some())
            .finish()
    }
}

/// Why the sidecar did not follow a Server Redirection. Each is a terminal
/// [`SidecarFailureKind::Protocol`](termihub_core::backends::rdp_sidecar::protocol::SidecarFailureKind::Protocol)
/// failure: a re-dial of the same host would meet the same redirection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedirectRefused {
    /// A redirection beyond [`MAX_REDIRECT_HOPS`].
    TooManyHops {
        /// The server the refused redirection named.
        target: String,
    },
    /// A redirection back to a target already visited with the same routing
    /// token and session.
    Loop {
        /// The revisited server.
        target: String,
    },
    /// The connection runs through an SSH tunnel, proxy or agent forward,
    /// which ends at the original server only.
    ThroughForward {
        /// The server the redirection named.
        target: String,
    },
    /// The redirection names no target and carries no routing token.
    NoTarget,
    /// The routing token is not the printable ASCII an X.224 request carries.
    UnusableRoutingToken {
        /// The server the redirection named.
        target: String,
    },
}

impl fmt::Display for RedirectRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyHops { target } => write!(
                f,
                "The RDP server redirected the connection again, to {target}, after \
                 {MAX_REDIRECT_HOPS} redirections; termiHub stops following RDP server \
                 redirections after {MAX_REDIRECT_HOPS} hops. Check the connection broker's \
                 configuration"
            ),
            Self::Loop { target } => write!(
                f,
                "The RDP servers redirected the connection in a loop, back to {target}; \
                 termiHub stopped following the redirections. Check the connection broker's \
                 configuration"
            ),
            Self::ThroughForward { target } => write!(
                f,
                "The RDP server redirected the connection to {target} (a connection broker or \
                 load balancer), but this connection runs through an SSH tunnel, proxy or \
                 agent that only reaches the original server. Connect to {target} directly"
            ),
            Self::NoTarget => write!(
                f,
                "The RDP server redirected the connection without naming a target server"
            ),
            Self::UnusableRoutingToken { target } => write!(
                f,
                "The RDP server redirected the connection to {target} with a routing token \
                 termiHub can't send"
            ),
        }
    }
}

impl std::error::Error for RedirectRefused {}

/// The non-secret name of a redirection's target: its FQDN, NetBIOS name or
/// first address, else `"another server"`.
pub fn target_name(pdu: &ServerRedirectionPdu) -> String {
    [
        pdu.target_fqdn.as_deref(),
        pdu.target_netbios_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(clean)
    .chain(target_addresses(pdu))
    .next()
    .unwrap_or_else(|| "another server".to_string())
}

/// The addresses a redirection names, in the order the sidecar tries them,
/// trimmed and without duplicates (case-insensitive).
///
/// `TargetNetAddress` first — the address the broker resolved for this
/// client, and the field MS-RDPBCGR 2.2.13.1 ties the routing token to — then
/// each of `TargetNetAddresses`, then `TargetFQDN`, then `TargetNetBiosName`.
/// Literal addresses go before names because a client outside the farm's DNS
/// domain may not resolve the names at all; a name is the fallback for a
/// broker that sends no address.
pub fn target_addresses(pdu: &ServerRedirectionPdu) -> Vec<String> {
    let addresses = pdu.target_net_addresses.iter().flatten();
    let mut seen = HashSet::new();
    pdu.target_net_address
        .iter()
        .chain(addresses)
        .chain(pdu.target_fqdn.iter())
        .chain(pdu.target_netbios_name.iter())
        .filter_map(|name| clean(name))
        .filter(|name| seen.insert(name.to_ascii_lowercase()))
        .collect()
}

/// A name with surrounding whitespace and NUL terminators removed, or `None`
/// when nothing is left.
fn clean(name: &str) -> Option<String> {
    let name = name.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!name.is_empty()).then(|| name.to_string())
}

/// The redirection's `LoadBalanceInfo` as an X.224 routing token: the bytes
/// without their CRLF terminator, which must be 1..=238 printable ASCII
/// characters. `Ok(None)` when the PDU carries none.
fn routing_token(pdu: &ServerRedirectionPdu) -> Result<Option<String>, ()> {
    let Some(info) = pdu.load_balance_info.as_deref() else {
        return Ok(None);
    };
    let info = info.strip_suffix(b"\r\n").unwrap_or(info);
    let printable = info.iter().all(|byte| (0x20..=0x7E).contains(byte));
    if info.is_empty() || info.len() > MAX_ROUTING_TOKEN_LENGTH || !printable {
        return Err(());
    }
    Ok(Some(String::from_utf8_lossy(info).into_owned()))
}

/// Turn a Server Redirection PDU, received while connected to `issuer`, into
/// the parameters of the reconnect.
pub fn plan(pdu: &ServerRedirectionPdu, issuer: &Endpoint) -> Result<Redirect, RedirectRefused> {
    let routing_token = routing_token(pdu).map_err(|()| RedirectRefused::UnusableRoutingToken {
        target: target_name(pdu),
    })?;
    let addresses = target_addresses(pdu);
    let names_issuer = !addresses.is_empty()
        && addresses
            .iter()
            .all(|a| issuer.addresses.iter().any(|i| i.eq_ignore_ascii_case(a)));
    let (endpoint, back_to_issuer) = if addresses.is_empty() {
        // Revectoring: reconnect to the issuer and let the routing token
        // steer the connection (MS-RDPBCGR 1.3.8).
        if routing_token.is_none() {
            return Err(RedirectRefused::NoTarget);
        }
        (issuer.clone(), true)
    } else if names_issuer {
        (issuer.clone(), true)
    } else {
        let server_name = [
            pdu.target_fqdn.as_deref(),
            pdu.target_netbios_name.as_deref(),
        ]
        .into_iter()
        .flatten()
        .find_map(clean)
        .unwrap_or_else(|| addresses[0].clone());
        (
            Endpoint {
                addresses,
                server_name,
            },
            false,
        )
    };

    let password_cookie = match &pdu.password {
        Some(_)
            if pdu
                .flags
                .contains(ServerRedirectionFlags::PASSWORD_IS_PK_ENCRYPTED) =>
        {
            // An RDSTLS blob; IronRDP's connector does not speak RDSTLS.
            debug!("ignoring a PK-encrypted redirection password; the saved one authenticates");
            None
        }
        Some(cookie) if !cookie.is_empty() => Some(cookie.clone()),
        _ => None,
    };

    Ok(Redirect {
        endpoint,
        back_to_issuer,
        session_id: pdu.session_id,
        routing_token,
        username: pdu.username.as_deref().and_then(clean),
        domain: pdu.domain.as_deref().and_then(clean),
        password_cookie,
    })
}

/// One visited target: where, with which routing token, into which session.
type VisitKey = (Vec<String>, Option<String>, u32);

fn visit_key(endpoint: &Endpoint, routing_token: Option<&str>, session_id: u32) -> VisitKey {
    let mut addresses: Vec<String> = endpoint
        .addresses
        .iter()
        .map(|a| a.to_ascii_lowercase())
        .collect();
    addresses.sort();
    (addresses, routing_token.map(str::to_string), session_id)
}

/// Bounds the redirections one session follows: a hop limit and a loop guard.
#[derive(Debug)]
pub struct HopGuard {
    hops: usize,
    visited: HashSet<VisitKey>,
}

impl HopGuard {
    /// A guard for a session whose first connect went to `origin`.
    pub fn new(origin: &Endpoint) -> Self {
        Self {
            hops: 0,
            visited: HashSet::from([visit_key(origin, None, 0)]),
        }
    }

    /// The redirections followed so far.
    pub fn hops(&self) -> usize {
        self.hops
    }

    /// Admit `redirect` as the next hop, or refuse it as the
    /// `MAX_REDIRECT_HOPS + 1`-th redirection or a revisit.
    pub fn admit(&mut self, redirect: &Redirect) -> Result<(), RedirectRefused> {
        let target = redirect.endpoint.server_name.clone();
        if self.hops >= MAX_REDIRECT_HOPS {
            return Err(RedirectRefused::TooManyHops { target });
        }
        let key = visit_key(
            &redirect.endpoint,
            redirect.routing_token.as_deref(),
            redirect.session_id,
        );
        if !self.visited.insert(key) {
            return Err(RedirectRefused::Loop { target });
        }
        self.hops += 1;
        Ok(())
    }
}

/// What a preflight learns about a server's certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerIdentity {
    /// SHA-256 fingerprint of the server public key.
    pub fingerprint: String,
    /// Certificate subject, when available.
    pub subject: Option<String>,
    /// Certificate issuer, when available.
    pub issuer: Option<String>,
}

/// The two steps of admitting a new server, behind a seam so the ordering
/// (the trust gate before anything identifying goes out) is unit-tested.
pub trait Preflight {
    /// Dial `address`, negotiate X.224 without any client data (no username
    /// cookie, no routing token), upgrade to TLS and return the server's
    /// certificate identity. Sends nothing that names the user.
    async fn probe(&mut self, address: &str, server_name: &str) -> Result<ServerIdentity>;

    /// The certificate trust gate (#1758 / #1767) for `identity` presented by
    /// `server_name`: `Ok` to proceed, `Err` when it is not trusted.
    async fn trust(&mut self, server_name: &str, identity: &ServerIdentity) -> Result<()>;
}

/// A redirect target the trust gate admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    /// The address the reconnect dials.
    pub address: String,
    /// The fingerprint accepted in the preflight: the reconnect does not ask
    /// again for the same certificate. `None` when no preflight ran.
    pub trusted_fingerprint: Option<String>,
}

/// Admit `redirect`'s target before the reconnect sends it anything.
///
/// A target back at the issuer needs no preflight. Otherwise each address is
/// probed in order; the first that answers must pass the trust gate. A probe
/// failure (unreachable, not RDP) moves on to the next address; a trust
/// rejection ends the redirection.
pub async fn admit<P: Preflight>(preflight: &mut P, redirect: &Redirect) -> Result<Admitted> {
    let server_name = &redirect.endpoint.server_name;
    if redirect.back_to_issuer {
        return Ok(Admitted {
            address: redirect.endpoint.addresses[0].clone(),
            trusted_fingerprint: None,
        });
    }
    let mut last_error = None;
    for address in &redirect.endpoint.addresses {
        match preflight.probe(address, server_name).await {
            Ok(identity) => {
                preflight.trust(server_name, &identity).await?;
                return Ok(Admitted {
                    address: address.clone(),
                    trusted_fingerprint: Some(identity.fingerprint),
                });
            }
            Err(error) => {
                warn!(%address, error = format!("{error:#}"), "rdp redirect target unreachable");
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("the redirection names no address")))
}

/// A Server Redirection a reactivation met (#5137), carried out of the
/// reactivation sequence so the driver can follow it.
#[derive(Debug)]
pub struct RedirectRequested(pub Box<ServerRedirectionPdu>);

impl fmt::Display for RedirectRequested {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the RDP server redirected the session to {}",
            target_name(&self.0)
        )
    }
}

impl std::error::Error for RedirectRequested {}

/// Whether the certificate a connect met was already accepted for this
/// server in the redirect preflight.
pub fn already_trusted(trusted_fingerprint: Option<&str>, fingerprint: &str) -> bool {
    trusted_fingerprint == Some(fingerprint)
}

#[cfg(test)]
#[path = "redirect_tests.rs"]
mod tests;
