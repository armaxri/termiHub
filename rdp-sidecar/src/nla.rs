//! The CredSSP/NLA leg of the connect sequence, driven here instead of by
//! `ironrdp_tokio::connect_finalize` so the sidecar knows **which client message
//! a server's CredSSP error answers** (#3612).
//!
//! With no Kerberos config, IronRDP's CredSSP client speaks plain NTLM:
//!
//! 1. client → `TSRequest{negoTokens: NEGOTIATE}`
//! 2. server → `TSRequest{negoTokens: CHALLENGE}` — reply #1
//! 3. client → `TSRequest{negoTokens: AUTHENTICATE, pubKeyAuth}`
//! 4. server → `TSRequest{pubKeyAuth}` or `TSRequest{errorCode}` — reply #2
//!
//! An `errorCode` in reply #2 is the server refusing the AUTHENTICATE message —
//! the one that carries the password proof. Windows reports it with a logon
//! NTSTATUS (`STATUS_LOGON_FAILURE`); FreeRDP-based servers (FreeRDP shadow,
//! gnome-remote-desktop) report `NTSTATUS_FROM_WIN32(GetLastError())` — a stale
//! thread error such as `0xC00700EA` (`ERROR_MORE_DATA`) that says nothing about
//! the logon itself. The phase is therefore the reliable signal, and
//! [`failure::is_auth_credssp_rejection`] combines it with the code.
//!
//! Apart from counting server replies and typing that one rejection, the loop is
//! `ironrdp-async` 0.10's `connect_finalize` / `perform_credssp_step` verbatim.

use anyhow::Result;
use ironrdp::connector::credssp::{CredsspProcessGenerator, CredsspSequence};
use ironrdp::connector::sspi::credssp::ClientState;
use ironrdp::connector::sspi::generator::GeneratorState;
use ironrdp::connector::{
    ClientConnector, ClientConnectorState, ConnectionResult, ConnectorError, ConnectorErrorKind,
    ConnectorResult, ServerName, State as _,
};
use ironrdp::core::WriteBuf;
use ironrdp_tokio::{
    single_sequence_step, Framed, FramedRead, FramedWrite, NetworkClient, Upgraded,
};
use tracing::{debug, info, trace};

use crate::failure::{self, CredsspPhase, CredsspRejected};

/// Finish the connection after the TLS upgrade: CredSSP/NLA (when negotiated),
/// then channel join, capability exchange and finalization.
pub async fn connect_finalize<S, N>(
    _: Upgraded,
    mut connector: ClientConnector,
    framed: &mut Framed<S>,
    network_client: &mut N,
    server_name: ServerName,
    server_public_key: Vec<u8>,
) -> Result<ConnectionResult>
where
    S: FramedRead + FramedWrite,
    N: NetworkClient,
{
    let mut buf = WriteBuf::new();

    if connector.should_perform_credssp() {
        perform_credssp(
            &mut connector,
            framed,
            network_client,
            &mut buf,
            server_name,
            server_public_key,
        )
        .await?;
    }

    let result = loop {
        single_sequence_step(framed, &mut connector, &mut buf).await?;

        if let ClientConnectorState::Connected { result } = connector.state {
            break result;
        }
    };

    info!("Connected with success");

    Ok(result)
}

async fn perform_credssp<S, N>(
    connector: &mut ClientConnector,
    framed: &mut Framed<S>,
    network_client: &mut N,
    buf: &mut WriteBuf,
    server_name: ServerName,
    server_public_key: Vec<u8>,
) -> Result<()>
where
    S: FramedRead + FramedWrite,
    N: NetworkClient,
{
    let selected_protocol = match connector.state {
        ClientConnectorState::Credssp {
            selected_protocol, ..
        } => selected_protocol,
        _ => {
            return Err(ConnectorError::new("CredSSP", ConnectorErrorKind::General).into());
        }
    };

    let (mut sequence, mut ts_request) = CredsspSequence::init(
        connector.config.credentials.clone(),
        connector.config.domain.as_deref(),
        selected_protocol,
        server_name,
        server_public_key,
        // No Kerberos: the exchange is plain NTLM, which the phase count relies on.
        None,
    )?;

    // How many server TSRequests have been fed to the client so far; the first
    // processed request is the client's own empty initial one.
    let mut server_replies = 0usize;

    loop {
        let client_state = {
            let mut generator = sequence.process_ts_request(ts_request);
            resolve_generator(&mut generator, network_client).await
        };
        let client_state = client_state.map_err(|error| typed_rejection(error, server_replies))?;

        buf.clear();
        let written = sequence.handle_process_result(client_state, buf)?;

        if let Some(response_len) = written.size() {
            let response = &buf[..response_len];
            trace!(response_len, "Send response");
            framed
                .write_all(response)
                .await
                .map_err(|e| ironrdp::connector::custom_err!("write all", e))?;
        }

        let Some(next_pdu_hint) = sequence.next_pdu_hint() else {
            break;
        };

        debug!(
            connector.state = connector.state.name(),
            hint = ?next_pdu_hint,
            "Wait for PDU"
        );

        let pdu = framed
            .read_by_hint(next_pdu_hint)
            .await
            .map_err(|e| ironrdp::connector::custom_err!("read frame by hint", e))?;

        trace!(length = pdu.len(), "PDU received");

        if let Some(next_request) = sequence.decode_server_message(&pdu)? {
            server_replies += 1;
            ts_request = next_request;
        } else {
            break;
        }
    }

    connector.mark_credssp_as_done();

    Ok(())
}

/// Wrap a CredSSP failure the server raised in reply to the AUTHENTICATE message
/// as a typed [`CredsspRejected`], so [`failure::classify`] reports it as auth.
fn typed_rejection(error: ConnectorError, server_replies: usize) -> anyhow::Error {
    let phase = CredsspPhase::from_server_replies(server_replies);
    if let ConnectorErrorKind::Credssp(sspi_error) = error.kind() {
        if let Some(status) = sspi_error.nstatus {
            if failure::is_auth_credssp_rejection(sspi_error, phase) {
                return CredsspRejected {
                    status,
                    source: error,
                }
                .into();
            }
        }
    }
    error.into()
}

async fn resolve_generator(
    generator: &mut CredsspProcessGenerator<'_>,
    network_client: &mut impl NetworkClient,
) -> ConnectorResult<ClientState> {
    let mut state = generator.start();

    loop {
        match state {
            GeneratorState::Suspended(request) => {
                let response = network_client.send(&request).await?;
                state = generator.resume(Ok(response));
            }
            GeneratorState::Completed(client_state) => {
                break client_state
                    .map_err(|e| ConnectorError::new("CredSSP", ConnectorErrorKind::Credssp(e)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::connector::sspi;

    fn server_error(status: u32) -> ConnectorError {
        ConnectorError::new(
            "CredSSP",
            ConnectorErrorKind::Credssp(sspi::Error::new_with_nstatus(
                sspi::ErrorKind::InvalidToken,
                "CredSSP server returned an error status",
                sspi::credssp::NStatusCode(status),
            )),
        )
    }

    /// The FreeRDP shadow server's wrong-password reply arrives as server reply
    /// #2 (answering AUTHENTICATE) and must come out typed (#3612).
    #[test]
    fn error_in_reply_to_authenticate_is_typed_as_a_rejection() {
        let err = typed_rejection(server_error(0xc007_00ea), 2);
        let rejected = err
            .downcast_ref::<CredsspRejected>()
            .expect("typed rejection");
        assert_eq!(rejected.status.0, 0xc007_00ea);
    }

    #[test]
    fn error_in_reply_to_negotiate_is_passed_through() {
        let err = typed_rejection(server_error(0xc007_00ea), 1);
        assert!(err.downcast_ref::<CredsspRejected>().is_none());
        assert!(err.downcast_ref::<ConnectorError>().is_some());
    }

    #[test]
    fn non_credssp_errors_are_passed_through() {
        let err = typed_rejection(
            ConnectorError::new("CredSSP", ConnectorErrorKind::General),
            2,
        );
        assert!(err.downcast_ref::<CredsspRejected>().is_none());
    }
}
