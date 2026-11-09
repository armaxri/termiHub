#![cfg_attr(doc, doc = include_str!("../README.md"))]
#![doc(html_logo_url = "https://cdnweb.devolutions.net/images/projects/devolutions/logos/devolutions-icon-shadow.svg")]
#![allow(clippy::arithmetic_side_effects)] // FIXME: remove

use ironrdp_core::{ReadCursor, impl_as_any};
use ironrdp_pdu::gcc::ChannelName;
use ironrdp_pdu::{PduResult, decode_err, pdu_other_err};
use ironrdp_svc::{CompressionCondition, SvcClientProcessor, SvcMessage, SvcProcessor};
use pdu::efs::{
    AnyIoCtlCode, Capabilities, ClientDeviceListAnnounce, ClientDeviceListRemove, ClientDriveQueryDirectoryResponse,
    ClientDriveQueryVolumeInformationResponse, ClientDriveSetInformationResponse, ClientNameRequest,
    ClientNameRequestUnicodeFlag, CoreCapability, CoreCapabilityKind, DEFAULT_PRINTER_DRIVER_NAME,
    DeviceAnnounceHeader, DeviceCloseResponse, DeviceControlRequest, DeviceControlResponse, DeviceIoRequest,
    DeviceIoResponse, DeviceType, Devices, MajorFunction, NtStatus, PrinterIoRequest, ServerDeviceAnnounceResponse,
    UnknownMajorFunctionRequest, UnsupportedDriveIoRequest, VERSION_MINOR_RDP51, VersionAndIdPdu, VersionAndIdPduKind,
};
use pdu::esc::{ScardCall, ScardIoCtlCode};
use pdu::{DeviceIoCompletion, PacketId, RdpdrPdu, SharedHeader};
use tracing::{debug, trace, warn};

pub mod backend;
pub mod pdu;

pub use self::backend::RdpdrBackend;
pub use self::backend::noop::NoopRdpdrBackend;
use crate::pdu::efs::ServerDriveIoRequest;

/// The RDPDR channel as specified in [\[MS-RDPEFS\]].
///
/// This channel must always be advertised with the "rdpsnd"
/// channel in order for the server to send anything back to it,
/// see: [\[MS-RDPEFS\] Appendix A<1>]
///
/// [\[MS-RDPEFS\]]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/34d9de58-b2b5-40b6-b970-f82d4603bdb5
/// [\[MS-RDPEFS\] Appendix A<1>]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/fd28bfd9-dae2-4a78-abe1-b4efa208b7aa#Appendix_A_1
#[derive(Debug)]
pub struct Rdpdr {
    /// The name of the computer that is running the client.
    ///
    /// Any directories shared will be displayed by File Explorer
    /// as "`<directory>` on `<computer_name>`".
    computer_name: String,
    capabilities: Capabilities,
    /// Pre-configured list of devices to announce to the server.
    ///
    /// All devices not of the type [`DeviceType::Filesystem`] must be declared here.
    device_list: Devices,
    post_logon_devices_announced: bool,
    backend: Option<Box<dyn RdpdrBackend>>,
}

impl_as_any!(Rdpdr);

impl Rdpdr {
    pub const NAME: ChannelName = ChannelName::from_static(b"rdpdr\0\0\0");

    /// Creates a new [`Rdpdr`].
    pub fn new(backend: Box<dyn RdpdrBackend>, computer_name: String) -> Self {
        Self {
            computer_name,
            capabilities: Capabilities::new(),
            device_list: Devices::new(),
            post_logon_devices_announced: false,
            backend: Some(backend),
        }
    }

    #[must_use]
    pub fn with_smartcard(mut self, device_id: u32) -> Self {
        self.capabilities.add_smartcard();
        self.device_list.add_smartcard(device_id);
        self
    }

    /// Adds drive redirection capability.
    ///
    /// Callers may also include `initial_drives` to pre-configure the list of drives to announce to the server.
    /// Note that drives do not need to be pre-configured in order to be redirected, a new drive can be announced
    /// at any time during a session by calling [`Self::add_drive`].
    #[must_use]
    pub fn with_drives(mut self, initial_drives: Option<Vec<(u32, String)>>) -> Self {
        self.capabilities.add_drive();
        if let Some(initial_drives) = initial_drives {
            for (device_id, path) in initial_drives {
                self.device_list.add_drive(device_id, path);
            }
        }
        self
    }

    /// Adds printer redirection capability and announces a single
    /// virtual printer under `device_id` with the user-visible name
    /// `print_name`.
    ///
    /// Uses [`DEFAULT_PRINTER_DRIVER_NAME`] as the PostScript driver and
    /// marks the device as the session's default printer — see
    /// [`pdu::efs::Devices::add_printer`] for the rationale. IRPs
    /// targeting this device are dispatched to
    /// [`RdpdrBackend::handle_printer_io_request`].
    #[must_use]
    pub fn with_printer(self, device_id: u32, print_name: String) -> Self {
        self.with_printer_driver(device_id, print_name, DEFAULT_PRINTER_DRIVER_NAME.to_owned())
    }

    /// Adds printer redirection capability with an explicit server-side
    /// printer driver name.
    ///
    /// Use this when the target host needs a driver other than
    /// [`DEFAULT_PRINTER_DRIVER_NAME`] for the redirected printer queue.
    #[must_use]
    pub fn with_printer_driver(mut self, device_id: u32, print_name: String, driver_name: String) -> Self {
        self.capabilities.add_printer();
        self.device_list
            .add_printer_with_driver(device_id, print_name, driver_name);
        self
    }

    /// Users should call this method to announce a new drive to the server. It's the caller's responsibility
    /// to take the returned [`ClientDeviceListAnnounce`] and send it to the server.
    pub fn add_drive(&mut self, device_id: u32, name: String) -> ClientDeviceListAnnounce {
        self.device_list.add_drive(device_id, name.clone());
        ClientDeviceListAnnounce::new_drive(device_id, name)
    }

    pub fn remove_device(&mut self, device_id: u32) -> Option<ClientDeviceListRemove> {
        Some(ClientDeviceListRemove::remove_device(
            self.device_list.remove_device(device_id)?,
        ))
    }

    pub fn downcast_backend<T: RdpdrBackend>(&self) -> Option<&T> {
        self.backend.as_ref()?.as_any().downcast_ref::<T>()
    }

    pub fn downcast_backend_mut<T: RdpdrBackend>(&mut self) -> Option<&mut T> {
        self.backend.as_mut()?.as_any_mut().downcast_mut::<T>()
    }

    fn handle_server_announce(&mut self, req: VersionAndIdPdu) -> PduResult<Vec<SvcMessage>> {
        let client_announce_reply =
            RdpdrPdu::VersionAndIdPdu(VersionAndIdPdu::new_client_announce_reply(req).map_err(|e| decode_err!(e))?);
        trace!("sending {:?}", client_announce_reply);

        let client_name_request = RdpdrPdu::ClientNameRequest(ClientNameRequest::new(
            self.computer_name.clone(),
            ClientNameRequestUnicodeFlag::Unicode,
        ));
        trace!("sending {:?}", client_name_request);

        Ok(vec![
            SvcMessage::from(client_announce_reply),
            SvcMessage::from(client_name_request),
        ])
    }

    fn handle_server_capability(&mut self, req: CoreCapability) -> PduResult<Vec<SvcMessage>> {
        let client_capability_response =
            RdpdrPdu::CoreCapability(CoreCapability::new_response(self.capabilities.clone_supported_by(&req)));
        trace!("sending {:?}", client_capability_response);
        Ok(vec![SvcMessage::from(client_capability_response)])
    }

    fn handle_client_id_confirm(&mut self, req: VersionAndIdPdu) -> PduResult<Vec<SvcMessage>> {
        let announce_all_devices = req.version_minor == VERSION_MINOR_RDP51;
        if announce_all_devices {
            self.post_logon_devices_announced = true;
        }

        let device_list = self
            .device_list
            .clone_inner()
            .into_iter()
            .filter(|device| announce_all_devices || Self::is_pre_logon_device(device))
            .collect::<Vec<_>>();

        if device_list.is_empty() {
            return Ok(Vec::new());
        }

        Self::announce_devices(device_list)
    }

    fn announce_post_logon_devices(&mut self) -> PduResult<Vec<SvcMessage>> {
        if self.post_logon_devices_announced {
            return Ok(Vec::new());
        }

        self.post_logon_devices_announced = true;

        let device_list = self
            .device_list
            .clone_inner()
            .into_iter()
            .filter(|device| !Self::is_pre_logon_device(device))
            .collect::<Vec<_>>();

        if device_list.is_empty() {
            return Ok(Vec::new());
        }

        Self::announce_devices(device_list)
    }

    fn is_pre_logon_device(device: &DeviceAnnounceHeader) -> bool {
        matches!(device.device_type(), DeviceType::Smartcard)
    }

    fn announce_devices(device_list: Vec<DeviceAnnounceHeader>) -> PduResult<Vec<SvcMessage>> {
        let res = RdpdrPdu::ClientDeviceListAnnounce(ClientDeviceListAnnounce { device_list });
        trace!("sending {:?}", res);
        Ok(vec![SvcMessage::from(res)])
    }

    fn handle_server_device_announce_response(
        &mut self,
        pdu: ServerDeviceAnnounceResponse,
    ) -> PduResult<Vec<SvcMessage>> {
        self.backend
            .as_mut()
            .ok_or_else(|| pdu_other_err!("missing rdpdr backend"))?
            .handle_server_device_announce_response(pdu)?;
        Ok(Vec::new())
    }

    fn handle_user_logged_on(&mut self) -> PduResult<Vec<SvcMessage>> {
        let mut backend = self.backend.take().expect("missing rdpdr backend");
        let res = backend.handle_user_logged_on(self);
        self.backend = Some(backend);
        let mut messages = res?;
        messages.extend(self.announce_post_logon_devices()?);
        trace!("sending {:?}", messages);
        Ok(messages)
    }

    fn handle_device_io_request(
        &mut self,
        dev_io_req: DeviceIoRequest,
        src: &mut ReadCursor<'_>,
    ) -> PduResult<Vec<SvcMessage>> {
        let Ok(device_type) = self.device_list.for_device_type(dev_io_req.device_id) else {
            // > If a request is received that contains a DeviceId field that was not announced by the client or has
            // > been removed, the request SHOULD be ignored by the implementation.
            // source: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/9925f2e4-8d5a-4777-a41a-7ba6ef6e8bff
            return Ok(vec![]);
        };

        match device_type {
            DeviceType::Smartcard => {
                let req =
                    DeviceControlRequest::<ScardIoCtlCode>::decode(dev_io_req, src).map_err(|e| decode_err!(e))?;
                let call = ScardCall::decode(req.io_control_code, src).map_err(|e| decode_err!(e))?;

                debug!(?req);
                debug!(?req.io_control_code, ?call);

                self.backend
                    .as_mut()
                    .ok_or_else(|| pdu_other_err!("missing rdpdr backend"))?
                    .handle_scard_call(req, call)?;

                Ok(Vec::new())
            }
            DeviceType::Filesystem => {
                // termiHub fork delta (#5118, upstream 0f9154d2): a well-formed request this crate does
                // not implement is completed with a failure status instead of ending the session.
                let req = match ServerDriveIoRequest::decode_or_unsupported(dev_io_req, src)
                    .map_err(|e| decode_err!(e))?
                {
                    Ok(req) => req,
                    Err(unsupported) => return Ok(vec![Self::unsupported_drive_io_response(unsupported)]),
                };

                debug!(?req);

                Ok(self
                    .backend
                    .as_mut()
                    .ok_or_else(|| pdu_other_err!("missing rdpdr backend"))?
                    .handle_drive_io_request(req)?)
            }
            DeviceType::Print => match dev_io_req.major_function {
                MajorFunction::DeviceControl => {
                    let req =
                        DeviceControlRequest::<AnyIoCtlCode>::decode(dev_io_req, src).map_err(|e| decode_err!(e))?;
                    debug!(?req, "Completing printer device-control IRP");

                    Ok(vec![SvcMessage::from(RdpdrPdu::DeviceControlResponse(
                        DeviceControlResponse::new(req, NtStatus::SUCCESS, None),
                    ))])
                }
                MajorFunction::Create | MajorFunction::Write | MajorFunction::Close => {
                    let req = PrinterIoRequest::decode(dev_io_req, src).map_err(|e| decode_err!(e))?;
                    debug!(?req, "Dispatching printer IRP to backend");
                    self.backend
                        .as_mut()
                        .ok_or_else(|| pdu_other_err!("missing rdpdr backend"))?
                        .handle_printer_io_request(req)
                }
                _ => {
                    debug!(
                        major = ?dev_io_req.major_function,
                        minor = ?dev_io_req.minor_function,
                        file_id = dev_io_req.file_id,
                        completion_id = dev_io_req.completion_id,
                        "Completing unsupported printer IRP"
                    );

                    Ok(vec![Self::unsupported_printer_io_response(dev_io_req)])
                }
            },
            _ => {
                // This should never happen, as we only announce devices that we support.
                warn!(?dev_io_req, "received packet for unsupported device type");
                Ok(Vec::new())
            }
        }
    }

    /// termiHub fork delta (#5118, upstream 0f9154d2): completes a filesystem IRP that is
    /// well-formed but asks for a function or information class this client does not implement,
    /// so that the server receives a failure status instead of the whole session being torn down.
    ///
    /// MS-RDPEFS 3.1.5.2 says an unrecognized field value SHOULD terminate the channel, and an
    /// information class outside a request's table is one. Like FreeRDP, such requests are completed
    /// with STATUS_NOT_SUPPORTED instead, which keeps the session alive.
    fn unsupported_drive_io_response(req: UnsupportedDriveIoRequest) -> SvcMessage {
        let not_supported = |device_io_request| DeviceIoResponse::new(device_io_request, NtStatus::NOT_SUPPORTED);

        let message = match req {
            UnsupportedDriveIoRequest::SetVolumeInformation {
                device_io_request,
                length,
            } => SvcMessage::from(DeviceIoCompletion::SetVolumeInformation {
                device_io_reply: not_supported(device_io_request),
                length,
            }),
            UnsupportedDriveIoRequest::SetInformation {
                device_io_request,
                length,
            } => SvcMessage::from(RdpdrPdu::ClientDriveSetInformationResponse(
                ClientDriveSetInformationResponse {
                    device_io_reply: not_supported(device_io_request),
                    length,
                },
            )),
            UnsupportedDriveIoRequest::QueryVolumeInformation(device_io_request) => SvcMessage::from(
                RdpdrPdu::ClientDriveQueryVolumeInformationResponse(ClientDriveQueryVolumeInformationResponse {
                    device_io_reply: not_supported(device_io_request),
                    buffer: None,
                }),
            ),
            UnsupportedDriveIoRequest::QueryDirectory(device_io_request) => SvcMessage::from(
                RdpdrPdu::ClientDriveQueryDirectoryResponse(ClientDriveQueryDirectoryResponse {
                    device_io_reply: not_supported(device_io_request),
                    buffer: None,
                }),
            ),
            // > If the request contains MajorFunction or MinorFunction fields that are not described by this
            // > protocol, the request SHOULD be completed with a Device I/O Response message that has the
            // > IoStatus field set to STATUS_UNSUCCESSFUL.
            // source: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/9925f2e4-8d5a-4777-a41a-7ba6ef6e8bff
            UnsupportedDriveIoRequest::DirectoryControl(device_io_request) => SvcMessage::from(
                DeviceIoCompletion::Bare(DeviceIoResponse::new(device_io_request, NtStatus::UNSUCCESSFUL)),
            ),
            // termiHub fork delta (#5124): MS-RDPEFS does not describe the security functions, but
            // Windows clients implement them with these response layouts (upstream master's
            // `ClientDriveQuerySecurityResponse` / `ClientDriveSetSecurityResponse`). This client
            // has no Windows ACLs to report or apply, so they are completed as not supported,
            // which is what a Windows file system without security support answers.
            UnsupportedDriveIoRequest::QuerySecurity(device_io_request) => {
                SvcMessage::from(DeviceIoCompletion::QuerySecurity(not_supported(device_io_request)))
            }
            UnsupportedDriveIoRequest::SetSecurity {
                device_io_request,
                length,
            } => SvcMessage::from(DeviceIoCompletion::SetSecurity {
                device_io_reply: not_supported(device_io_request),
                length,
            }),
        };
        debug!(?message, "Completing unsupported filesystem IRP");

        message
    }

    /// termiHub fork delta (#5124): completes a Device I/O Request whose MajorFunction this crate
    /// does not know, for a device the client announced. Ignored like any other request when the
    /// device was not announced (MS-RDPEFS 3.1.5.2).
    ///
    /// > If the request contains MajorFunction or MinorFunction fields that are not described by this
    /// > protocol, the request SHOULD be completed with a Device I/O Response message that has the
    /// > IoStatus field set to STATUS_UNSUCCESSFUL.
    /// source: <https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/9925f2e4-8d5a-4777-a41a-7ba6ef6e8bff>
    fn handle_unknown_major_function(&self, req: UnknownMajorFunctionRequest) -> Vec<SvcMessage> {
        if self.device_list.for_device_type(req.device_id).is_err() {
            return Vec::new();
        }
        debug!(
            device_id = req.device_id,
            completion_id = req.completion_id,
            major = format_args!("{:#010x}", req.major_function),
            "Completing IRP with an unknown MajorFunction"
        );

        vec![SvcMessage::from(DeviceIoCompletion::Bare(DeviceIoResponse {
            device_id: req.device_id,
            completion_id: req.completion_id,
            io_status: NtStatus::UNSUCCESSFUL,
        }))]
    }

    fn unsupported_printer_io_response(device_io_request: DeviceIoRequest) -> SvcMessage {
        SvcMessage::from(RdpdrPdu::DeviceCloseResponse(DeviceCloseResponse {
            device_io_response: DeviceIoResponse::new(device_io_request, NtStatus::NOT_SUPPORTED),
        }))
    }
}

impl SvcProcessor for Rdpdr {
    fn channel_name(&self) -> ChannelName {
        Self::NAME
    }

    fn compression_condition(&self) -> CompressionCondition {
        CompressionCondition::WhenRdpDataIsCompressed
    }

    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        let mut src = ReadCursor::new(payload);
        let header = SharedHeader::decode(&mut src).map_err(|e| decode_err!(e))?;
        if matches!(header.packet_id, PacketId::PrnCacheData | PacketId::PrnUsingXps) {
            warn!(
                packet_id = ?header.packet_id,
                "Ignoring unhandled RDPDR printer-cache PDU"
            );
            return Ok(vec![]);
        }

        // termiHub fork delta (#5124): a Device I/O Request with a MajorFunction this crate does not
        // know is completed instead of failing to decode, which would end the whole session.
        if header.packet_id == PacketId::CoreDeviceIoRequest {
            let req = DeviceIoRequest::decode_or_unknown(&mut src).map_err(|e| decode_err!(e))?;
            return match req {
                Ok(req) => self.handle_device_io_request(req, &mut src),
                Err(unknown) => Ok(self.handle_unknown_major_function(unknown)),
            };
        }

        let pdu = RdpdrPdu::decode_body(header, &mut src).map_err(|e| decode_err!(e))?;
        debug!("Received {:?}", pdu);

        match pdu {
            RdpdrPdu::VersionAndIdPdu(pdu) if pdu.kind == VersionAndIdPduKind::ServerAnnounceRequest => {
                self.handle_server_announce(pdu)
            }
            RdpdrPdu::CoreCapability(pdu) if pdu.kind == CoreCapabilityKind::ServerCoreCapabilityRequest => {
                self.handle_server_capability(pdu)
            }
            RdpdrPdu::VersionAndIdPdu(pdu) if pdu.kind == VersionAndIdPduKind::ServerClientIdConfirm => {
                self.handle_client_id_confirm(pdu)
            }
            RdpdrPdu::ServerDeviceAnnounceResponse(pdu) => self.handle_server_device_announce_response(pdu),
            RdpdrPdu::DeviceIoRequest(pdu) => self.handle_device_io_request(pdu, &mut src),
            RdpdrPdu::UserLoggedon => self.handle_user_logged_on(),
            // TODO: This can eventually become a `_ => {}` block, but being explicit for now
            // to make sure we don't miss handling new RdpdrPdu variants here during active development.
            RdpdrPdu::ClientNameRequest(_)
            | RdpdrPdu::ClientDeviceListAnnounce(_)
            | RdpdrPdu::ClientDeviceListRemove(_)
            | RdpdrPdu::VersionAndIdPdu(_)
            | RdpdrPdu::CoreCapability(_)
            | RdpdrPdu::DeviceControlResponse(_)
            | RdpdrPdu::DeviceCreateResponse(_)
            | RdpdrPdu::ClientDriveQueryInformationResponse(_)
            | RdpdrPdu::DeviceCloseResponse(_)
            | RdpdrPdu::ClientDriveQueryDirectoryResponse(_)
            | RdpdrPdu::ClientDriveQueryVolumeInformationResponse(_)
            | RdpdrPdu::DeviceReadResponse(_)
            | RdpdrPdu::DeviceWriteResponse(_)
            | RdpdrPdu::ClientDriveSetInformationResponse(_)
            | RdpdrPdu::DeviceFlushBuffersResponse(_)
            | RdpdrPdu::EmptyResponse => Err(pdu_other_err!("Rdpdr", "received unexpected packet")),
        }
    }
}

impl SvcClientProcessor for Rdpdr {}

// termiHub fork delta (#5118): tests for completing unsupported drive IRPs (port of upstream
// 0f9154d2, whose own tests live in ironrdp-testsuite-core and are adapted here to 0.7.0).
#[cfg(test)]
mod termihub_fork_tests {
    use ironrdp_core::{encode_vec, impl_as_any};

    use super::*;
    use crate::pdu::efs::MinorFunction;

    const DEVICE_ID: u32 = 42;
    const COMPLETION_ID: u32 = 0x100;

    /// Records the drive requests that reach the backend.
    #[derive(Debug, Default)]
    struct RecordingBackend {
        drive_requests: Vec<ServerDriveIoRequest>,
    }

    impl_as_any!(RecordingBackend);

    impl RdpdrBackend for RecordingBackend {
        fn handle_server_device_announce_response(&mut self, _pdu: ServerDeviceAnnounceResponse) -> PduResult<()> {
            Ok(())
        }
        fn handle_scard_call(&mut self, _req: DeviceControlRequest<ScardIoCtlCode>, _call: ScardCall) -> PduResult<()> {
            Ok(())
        }
        fn handle_drive_io_request(&mut self, req: ServerDriveIoRequest) -> PduResult<Vec<SvcMessage>> {
            self.drive_requests.push(req);
            Ok(Vec::new())
        }
    }

    fn drive_rdpdr() -> Rdpdr {
        Rdpdr::new(Box::<RecordingBackend>::default(), "termiHub".to_owned())
            .with_drives(Some(vec![(DEVICE_ID, "share".to_owned())]))
    }

    fn backend_requests(rdpdr: &Rdpdr) -> usize {
        rdpdr
            .downcast_backend::<RecordingBackend>()
            .expect("recording backend")
            .drive_requests
            .len()
    }

    fn read_u32(bytes: &[u8]) -> u32 {
        u32::from_le_bytes(bytes[..4].try_into().expect("4 bytes"))
    }

    fn device_io_request(major_function: MajorFunction, minor_function: MinorFunction) -> Vec<u8> {
        encode_vec(&RdpdrPdu::DeviceIoRequest(DeviceIoRequest {
            device_id: DEVICE_ID,
            file_id: 1,
            completion_id: COMPLETION_ID,
            major_function,
            minor_function,
        }))
        .expect("encode the device I/O request header")
    }

    /// A request laid out as FsInformationClass, Length, Padding (24 bytes), Buffer, as the query
    /// volume information, set volume information and set information requests are.
    fn information_request(major_function: MajorFunction, class: u32, buffer: &[u8]) -> Vec<u8> {
        let mut encoded = device_io_request(major_function, MinorFunction::from(0));
        encoded.extend_from_slice(&class.to_le_bytes());
        encoded.extend_from_slice(&u32::try_from(buffer.len()).expect("fits").to_le_bytes());
        encoded.extend_from_slice(&[0; 24]); // Padding
        encoded.extend_from_slice(buffer);
        encoded
    }

    /// A query directory request for `class` with an initial query on `*`.
    fn query_directory_request(class: u32) -> Vec<u8> {
        let path = [b'*', 0, 0, 0];
        let mut encoded = device_io_request(MajorFunction::DirectoryControl, MinorFunction::IRP_MN_QUERY_DIRECTORY);
        encoded.extend_from_slice(&class.to_le_bytes());
        encoded.push(1); // InitialQuery
        encoded.extend_from_slice(&u32::try_from(path.len()).expect("fits").to_le_bytes());
        encoded.extend_from_slice(&[0; 23]); // Padding
        encoded.extend_from_slice(&path);
        encoded
    }

    /// Processes `request` and returns the single encoded completion, after checking that it
    /// answers the request with `status` and that the backend never saw it.
    fn single_completion(rdpdr: &mut Rdpdr, request: &[u8], status: NtStatus) -> Vec<u8> {
        let before = backend_requests(rdpdr);
        let responses = rdpdr.process(request).expect("an unsupported IRP is not an error");
        assert_eq!(responses.len(), 1, "exactly one completion");
        assert_eq!(backend_requests(rdpdr), before, "the backend is not asked");

        let encoded = responses[0].encode_unframed_pdu().expect("encode the completion");
        assert_eq!(&encoded[..4], &[0x72, 0x44, 0x43, 0x49], "RDPDR_CTYP_CORE + PAKID_CORE_DEVICE_IOCOMPLETION");
        assert_eq!(read_u32(&encoded[4..]), DEVICE_ID, "DeviceId");
        assert_eq!(read_u32(&encoded[8..]), COMPLETION_ID, "CompletionId");
        assert_eq!(NtStatus::from(read_u32(&encoded[12..])), status, "IoStatus");
        encoded
    }

    #[test]
    fn set_volume_information_is_completed_as_not_supported() {
        let mut rdpdr = drive_rdpdr();
        // FileFsLabelInformation: VolumeLabelLength, VolumeLabel ("LB")
        let label = [4, 0, 0, 0, b'L', 0, b'B', 0];
        let request = information_request(MajorFunction::SetVolumeInformation, 0x02, &label);

        let encoded = single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);
        assert_eq!(encoded.len(), 20, "DR_DRIVE_SET_VOLUME_INFORMATION_RSP");
        assert_eq!(read_u32(&encoded[16..]), 8, "Length echoes the request (MS-RDPEFS 2.2.3.4.7)");

        // FileFsObjectIdInformation, outside the one class the request MUST contain
        let request = information_request(MajorFunction::SetVolumeInformation, 8, &[0; 4]);
        let encoded = single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);
        assert_eq!(read_u32(&encoded[16..]), 4);
    }

    #[test]
    fn set_information_with_unsupported_class_is_completed_as_not_supported() {
        let mut rdpdr = drive_rdpdr();
        // FilePositionInformation: CurrentByteOffset
        let request = information_request(MajorFunction::SetInformation, 14, &[0; 8]);

        let encoded = single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);
        assert_eq!(encoded.len(), 20, "DR_DRIVE_SET_INFORMATION_RSP");
        assert_eq!(read_u32(&encoded[16..]), 8, "Length echoes the request (MS-RDPEFS 2.2.3.4.9)");
    }

    #[test]
    fn query_volume_information_with_unsupported_class_is_completed_as_not_supported() {
        let mut rdpdr = drive_rdpdr();
        // FileFsControlInformation
        let request = information_request(MajorFunction::QueryVolumeInformation, 6, &[]);

        let encoded = single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);
        assert_eq!(encoded.len(), 20, "DR_DRIVE_QUERY_VOLUME_INFORMATION_RSP without a buffer");
        assert_eq!(read_u32(&encoded[16..]), 0, "Length");
    }

    #[test]
    fn query_directory_with_unsupported_class_is_completed_as_not_supported() {
        let mut rdpdr = drive_rdpdr();
        let request = query_directory_request(37); // FileIdBothDirectoryInformation

        let encoded = single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);
        assert_eq!(encoded.len(), 21, "DR_DRIVE_QUERY_DIRECTORY_RSP without a buffer");
        assert_eq!(read_u32(&encoded[16..]), 0, "Length, followed by one byte of padding");
    }

    #[test]
    fn directory_control_with_unknown_minor_function_is_completed_as_unsuccessful() {
        let mut rdpdr = drive_rdpdr();
        let request = device_io_request(MajorFunction::DirectoryControl, MinorFunction::from(0x99));

        let encoded = single_completion(&mut rdpdr, &request, NtStatus::UNSUCCESSFUL);
        assert_eq!(encoded.len(), 16, "header-only DR_DEVICE_IOCOMPLETION (MS-RDPEFS 3.1.5.2)");
    }

    #[test]
    fn supported_classes_still_reach_the_backend_after_an_unsupported_one() {
        let mut rdpdr = drive_rdpdr();
        let request = information_request(MajorFunction::SetVolumeInformation, 0x02, &[0; 4]);
        single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);

        // FileFsSizeInformation
        let request = information_request(MajorFunction::QueryVolumeInformation, 3, &[]);
        rdpdr.process(&request).expect("supported query volume information");
        // FileEndOfFileInformation: EndOfFile
        let request = information_request(MajorFunction::SetInformation, 20, &[0; 8]);
        rdpdr.process(&request).expect("supported set information");
        let request = query_directory_request(3); // FileBothDirectoryInformation
        rdpdr.process(&request).expect("supported query directory");

        assert_eq!(backend_requests(&rdpdr), 3, "every supported request reached the backend");
    }

    #[test]
    fn malformed_unsupported_drive_irps_are_still_decode_errors() {
        let mut rdpdr = drive_rdpdr();

        // SetVolumeBuffer shorter than its Length
        let mut request = information_request(MajorFunction::SetVolumeInformation, 0x02, &[0; 4]);
        request.pop();
        assert!(rdpdr.process(&request).is_err());

        // SetBuffer shorter than its Length
        let mut request = information_request(MajorFunction::SetInformation, 14, &[0; 8]);
        request.pop();
        assert!(rdpdr.process(&request).is_err());

        // Fixed part cut short
        let mut request = information_request(MajorFunction::QueryVolumeInformation, 6, &[]);
        request.pop();
        assert!(rdpdr.process(&request).is_err());

        // Path shorter than its PathLength
        let mut request = query_directory_request(37);
        request.pop();
        assert!(rdpdr.process(&request).is_err());
    }

    // termiHub fork delta (#5124): MajorFunctions 0.7.0 did not know.

    /// A raw Device I/O Request header with any MajorFunction value, for `device_id`.
    fn raw_device_io_request(device_id: u32, major_function: u32) -> Vec<u8> {
        let mut encoded = vec![0x72, 0x44, 0x52, 0x49]; // RDPDR_CTYP_CORE + PAKID_CORE_DEVICE_IOREQUEST
        for field in [device_id, 1, COMPLETION_ID, major_function, 0] {
            encoded.extend_from_slice(&field.to_le_bytes());
        }
        encoded
    }

    #[test]
    fn flush_buffers_reaches_the_backend() {
        let mut rdpdr = drive_rdpdr();
        let request = raw_device_io_request(DEVICE_ID, 0x09); // IRP_MJ_FLUSH_BUFFERS

        rdpdr.process(&request).expect("a flush does not end the session");
        let backend = rdpdr.downcast_backend::<RecordingBackend>().expect("recording backend");
        assert!(matches!(
            backend.drive_requests.as_slice(),
            [ServerDriveIoRequest::DeviceFlushBuffersRequest(req)]
                if req.device_io_request.major_function == MajorFunction::FlushBuffers
                    && req.device_io_request.completion_id == COMPLETION_ID
        ));
    }

    #[test]
    fn flush_buffers_response_is_a_header_only_completion() {
        let response = RdpdrPdu::DeviceFlushBuffersResponse(pdu::efs::DeviceFlushBuffersResponse {
            device_io_response: DeviceIoResponse {
                device_id: DEVICE_ID,
                completion_id: COMPLETION_ID,
                io_status: NtStatus::SUCCESS,
            },
        });
        let encoded = encode_vec(&response).expect("encode");
        assert_eq!(encoded.len(), 16, "DR_DEVICE_IOCOMPLETION without a body");
        assert_eq!(&encoded[..4], &[0x72, 0x44, 0x43, 0x49]);
        assert_eq!(read_u32(&encoded[12..]), 0, "STATUS_SUCCESS");
    }

    #[test]
    fn query_security_is_completed_as_not_supported() {
        let mut rdpdr = drive_rdpdr();
        let mut request = raw_device_io_request(DEVICE_ID, 0x14); // IRP_MJ_QUERY_SECURITY
        request.extend_from_slice(&0x0000_0007_u32.to_le_bytes()); // OWNER | GROUP | DACL

        let encoded = single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);
        assert_eq!(encoded.len(), 20, "query security response without a descriptor");
        assert_eq!(read_u32(&encoded[16..]), 0, "Length");
    }

    #[test]
    fn set_security_is_completed_as_not_supported() {
        let mut rdpdr = drive_rdpdr();
        let mut request = raw_device_io_request(DEVICE_ID, 0x15); // IRP_MJ_SET_SECURITY
        request.extend_from_slice(&0x0000_0004_u32.to_le_bytes()); // DACL
        request.extend_from_slice(&20_u32.to_le_bytes()); // Length
        request.extend_from_slice(&[0; 24]); // Padding
        request.extend_from_slice(&[1; 20]); // SecurityDescriptor

        let encoded = single_completion(&mut rdpdr, &request, NtStatus::NOT_SUPPORTED);
        assert_eq!(encoded.len(), 20, "set security response");
        assert_eq!(read_u32(&encoded[16..]), 20, "Length echoes the request");
    }

    #[test]
    fn unknown_major_function_is_completed_as_unsuccessful() {
        let mut rdpdr = drive_rdpdr();
        for major_function in [0x01, 0x07, 0x08, 0x0d, 0x10, 0x12, 0x16, 0x1b, 0xdead_beef] {
            let mut request = raw_device_io_request(DEVICE_ID, major_function);
            request.extend_from_slice(&[0xAA; 7]); // an unknown body is ignored

            let encoded = single_completion(&mut rdpdr, &request, NtStatus::UNSUCCESSFUL);
            assert_eq!(encoded.len(), 16, "header-only DR_DEVICE_IOCOMPLETION (MS-RDPEFS 3.1.5.2)");
        }

        // The channel keeps serving: FileFsSizeInformation still reaches the backend.
        let request = information_request(MajorFunction::QueryVolumeInformation, 3, &[]);
        rdpdr.process(&request).expect("supported query volume information");
        assert_eq!(backend_requests(&rdpdr), 1);
    }

    #[test]
    fn unknown_major_function_for_an_unannounced_device_is_ignored() {
        let mut rdpdr = drive_rdpdr();
        let responses = rdpdr
            .process(&raw_device_io_request(DEVICE_ID + 1, 0x42))
            .expect("not an error");
        assert!(responses.is_empty());
        let responses = rdpdr
            .process(&raw_device_io_request(DEVICE_ID + 1, 0x14))
            .expect("not an error");
        assert!(responses.is_empty());
    }

    #[test]
    fn malformed_requests_with_new_major_functions_are_still_decode_errors() {
        let mut rdpdr = drive_rdpdr();

        // Header cut short, with an unknown and a known MajorFunction
        for major_function in [0x42, 0x09] {
            let mut request = raw_device_io_request(DEVICE_ID, major_function);
            request.truncate(request.len() - 4);
            assert!(rdpdr.process(&request).is_err());
        }

        // Query security without its SecurityInformation
        let mut request = raw_device_io_request(DEVICE_ID, 0x14);
        request.extend_from_slice(&[0; 3]);
        assert!(rdpdr.process(&request).is_err());

        // Set security with a SecurityDescriptor shorter than its Length
        let mut request = raw_device_io_request(DEVICE_ID, 0x15);
        request.extend_from_slice(&0x0000_0004_u32.to_le_bytes());
        request.extend_from_slice(&20_u32.to_le_bytes());
        request.extend_from_slice(&[0; 24]);
        request.extend_from_slice(&[1; 19]);
        assert!(rdpdr.process(&request).is_err());

        // Set security without its fixed part
        let mut request = raw_device_io_request(DEVICE_ID, 0x15);
        request.extend_from_slice(&[0; 31]);
        assert!(rdpdr.process(&request).is_err());

        assert_eq!(backend_requests(&rdpdr), 0);
    }

    #[test]
    fn new_major_functions_round_trip() {
        for (value, major_function) in [
            (0x09, MajorFunction::FlushBuffers),
            (0x14, MajorFunction::QuerySecurity),
            (0x15, MajorFunction::SetSecurity),
        ] {
            assert_eq!(MajorFunction::try_from(value).expect("known"), major_function);
            assert_eq!(u32::from(major_function), value);
        }
        assert!(MajorFunction::try_from(0x42).is_err());

        // The public header decoder still rejects an unknown MajorFunction.
        let request = raw_device_io_request(DEVICE_ID, 0x42);
        assert!(DeviceIoRequest::decode(&mut ReadCursor::new(&request[4..])).is_err());
    }

    #[test]
    fn public_decode_still_rejects_unsupported_requests() {
        fn decode(request: &[u8]) -> ironrdp_core::DecodeResult<ServerDriveIoRequest> {
            let mut src = ReadCursor::new(request);
            let header = SharedHeader::decode(&mut src).expect("shared header");
            let RdpdrPdu::DeviceIoRequest(req) = RdpdrPdu::decode_body(header, &mut src).expect("decode") else {
                panic!("expected a device I/O request");
            };
            ServerDriveIoRequest::decode(req, &mut src)
        }

        assert!(decode(&information_request(MajorFunction::SetVolumeInformation, 0x02, &[0; 4])).is_err());
        assert!(decode(&information_request(MajorFunction::SetInformation, 14, &[0; 8])).is_err());
        assert!(decode(&information_request(MajorFunction::QueryVolumeInformation, 6, &[])).is_err());
        assert!(decode(&query_directory_request(37)).is_err());
        assert!(decode(&device_io_request(MajorFunction::DirectoryControl, MinorFunction::from(0x99))).is_err());
        assert!(decode(&information_request(MajorFunction::QueryVolumeInformation, 3, &[])).is_ok());

        // termiHub fork delta (#5124)
        let mut query_security = device_io_request(MajorFunction::QuerySecurity, MinorFunction::from(0));
        query_security.extend_from_slice(&[0; 4]);
        assert!(decode(&query_security).is_err());
        let mut set_security = device_io_request(MajorFunction::SetSecurity, MinorFunction::from(0));
        set_security.extend_from_slice(&[0; 32]);
        assert!(decode(&set_security).is_err());
        assert!(decode(&device_io_request(MajorFunction::FlushBuffers, MinorFunction::from(0))).is_ok());
    }
}
