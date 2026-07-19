//! RDPDR (MS-RDPEFS) drive redirection for the RDP sidecar (#1757).
//!
//! Exposes a single, user-selected local folder to the remote session as a
//! mapped drive. IronRDP's device-redirection channel
//! ([`ironrdp::rdpdr::Rdpdr`]) is a static virtual channel driven by an
//! [`RdpdrBackend`] the integrator supplies; the channel decodes the wire
//! protocol and dispatches filesystem I/O requests (IRPs) to the backend, which
//! serves them against the shared folder.
//!
//! Unlike CLIPRDR (#1756), the backend's methods build their response PDUs and
//! return them directly — the channel is not mutably borrowed re-entrantly — so
//! no deferred-event indirection is needed. Every IRP maps to at most one
//! response PDU; the handlers below return an [`RdpdrPdu`], and [`dispatch`]
//! wraps it into the channel's [`SvcMessage`] at the boundary.
//!
//! ## Security — sandboxed to one opted-in folder
//!
//! Drive redirection exposes local files to the (possibly untrusted) remote
//! host, so it is **off by default** and only ever serves the single folder the
//! user opted into per connection (`RdpConfig::shared_drive_root`). Every path
//! the server sends is resolved through [`DriveRedirectBackend::resolve`], which
//! rejects `..` traversal, drive letters and NUL bytes, and — for paths that
//! exist — canonicalises and verifies the result is still inside the share root,
//! defeating symlink escapes. The whole filesystem is never exposed.
//!
//! ## Scope
//!
//! Read + write of a redirected drive: open/create, close, read, write,
//! query-information, directory enumeration, volume information,
//! set-information (rename / delete / truncate). Audio playback (rdpsnd) and
//! CLIPRDR file transfer are sequenced follow-ups; rdpsnd is registered with a
//! no-op handler only because MS-RDPEFS requires it to be co-advertised with
//! rdpdr.
//!
//! [`dispatch`]: DriveRedirectBackend::dispatch

use std::collections::HashMap;
use std::fs::{self, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use ironrdp::core::impl_as_any;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::backend::RdpdrBackend;
use ironrdp::rdpdr::pdu::efs::{
    AnyIoCtlCode, Boolean, Characteristics, ClientDriveQueryDirectoryResponse,
    ClientDriveQueryInformationResponse, ClientDriveQueryVolumeInformationResponse,
    ClientDriveSetInformationResponse, CreateDisposition, CreateOptions, DesiredAccess,
    DeviceCloseRequest, DeviceCloseResponse, DeviceControlRequest, DeviceControlResponse,
    DeviceCreateRequest, DeviceCreateResponse, DeviceIoRequest, DeviceIoResponse,
    DeviceReadRequest, DeviceReadResponse, DeviceWriteRequest, DeviceWriteResponse,
    FileAttributeTagInformation, FileAttributes, FileBasicInformation,
    FileBothDirectoryInformation, FileDirectoryInformation, FileFsAttributeInformation,
    FileFsDeviceInformation, FileFsFullSizeInformation, FileFsSizeInformation,
    FileFsVolumeInformation, FileFullDirectoryInformation, FileInformationClass,
    FileInformationClassLevel, FileNamesInformation, FileStandardInformation, FileSystemAttributes,
    FileSystemInformationClass, FileSystemInformationClassLevel, Information, NtStatus,
    ServerDeviceAnnounceResponse, ServerDriveIoRequest, ServerDriveQueryDirectoryRequest,
    ServerDriveQueryInformationRequest, ServerDriveQueryVolumeInformationRequest,
    ServerDriveSetInformationRequest,
};
use ironrdp::rdpdr::pdu::esc::{ScardCall, ScardIoCtlCode};
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::svc::SvcMessage;
use tracing::{debug, warn};

/// Difference in seconds between the Windows FILETIME epoch (1601-01-01) and the
/// Unix epoch (1970-01-01).
const FILETIME_UNIX_EPOCH_DIFF_SECS: i64 = 11_644_473_600;

/// `FILE_DEVICE_DISK` — the device type reported for the redirected volume.
const FILE_DEVICE_DISK: u32 = 0x0000_0007;

// --- Fake volume geometry: enough capacity to make the drive appear usable. ---
const BYTES_PER_SECTOR: u32 = 512;
const SECTORS_PER_ALLOC_UNIT: u32 = 8; // 4 KiB clusters
/// ~8 GiB total / free, so the remote never treats the drive as full.
const FAKE_TOTAL_ALLOC_UNITS: i64 = 2 * 1024 * 1024;
const FAKE_AVAILABLE_ALLOC_UNITS: i64 = 2 * 1024 * 1024;

/// A file or directory the server has opened, keyed by the `file_id` this
/// backend assigned in the create response. Reads and writes reopen the path by
/// offset, so no OS handle is held across IRPs; only the metadata the protocol
/// needs is retained.
#[derive(Debug)]
struct OpenFile {
    /// Absolute, sandboxed path inside the share root.
    path: PathBuf,
    /// Whether the handle refers to a directory.
    is_dir: bool,
    /// Delete the path when the handle is closed (`FILE_DELETE_ON_CLOSE` or a
    /// later `FileDispositionInformation`).
    delete_on_close: bool,
    /// Lazily-built directory enumeration state (see [`DirListing`]).
    listing: Option<DirListing>,
}

/// Directory enumeration state: the server drains one entry per
/// `QueryDirectory` request until [`NtStatus::NO_MORE_FILES`].
#[derive(Debug)]
struct DirListing {
    entries: Vec<EnumEntry>,
    cursor: usize,
}

/// One directory entry, pre-resolved to the fields the wire format needs.
#[derive(Debug, Clone)]
struct EnumEntry {
    name: String,
    attributes: FileAttributes,
    size: i64,
    creation_time: i64,
    last_access_time: i64,
    last_write_time: i64,
}

/// The RDPDR filesystem backend for one redirected folder.
#[derive(Debug)]
pub struct DriveRedirectBackend {
    /// Canonicalised share root; every served path stays within it.
    root: PathBuf,
    /// Open handles keyed by the `file_id` we assigned.
    open_files: HashMap<u32, OpenFile>,
    /// Monotonic `file_id` allocator (0 is avoided as a sentinel).
    next_file_id: u32,
}

impl DriveRedirectBackend {
    /// Create a backend serving `root` (expected to already be a canonicalised
    /// existing directory — see `RdpConfig::shared_drive_root`).
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            open_files: HashMap::new(),
            next_file_id: 0,
        }
    }

    /// Resolve an RDP path (`\`-separated, relative to the share root) to a local
    /// path, or `None` if it escapes the sandbox. Delegates to the shared
    /// [`crate::sandbox::resolve_in_root`] choke point (rejects `..` traversal,
    /// drive letters / colons, and NUL bytes; canonicalises existing paths and
    /// re-checks them against the root to defeat symlink escapes).
    fn resolve(&self, rdp_path: &str) -> Option<PathBuf> {
        crate::sandbox::resolve_in_root(&self.root, rdp_path)
    }

    /// Allocate the next non-zero `file_id`.
    fn allocate_file_id(&mut self) -> u32 {
        self.next_file_id = self.next_file_id.wrapping_add(1);
        if self.next_file_id == 0 {
            self.next_file_id = 1;
        }
        self.next_file_id
    }

    /// Dispatch one decoded filesystem IRP to its handler, wrapping the response
    /// PDU (if any) into a channel message. Fire-and-forget requests (change
    /// notifications, byte-range locks) return no message.
    fn dispatch(&mut self, req: ServerDriveIoRequest) -> Vec<SvcMessage> {
        let pdu = match req {
            ServerDriveIoRequest::ServerCreateDriveRequest(req) => self.handle_create(req),
            ServerDriveIoRequest::DeviceCloseRequest(req) => self.handle_close(req),
            ServerDriveIoRequest::DeviceReadRequest(req) => self.handle_read(req),
            ServerDriveIoRequest::DeviceWriteRequest(req) => self.handle_write(req),
            ServerDriveIoRequest::ServerDriveQueryInformationRequest(req) => {
                self.handle_query_information(req)
            }
            ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(req) => {
                self.handle_query_directory(req)
            }
            ServerDriveIoRequest::ServerDriveQueryVolumeInformationRequest(req) => {
                self.handle_query_volume_information(req)
            }
            ServerDriveIoRequest::ServerDriveSetInformationRequest(req) => {
                self.handle_set_information(req)
            }
            ServerDriveIoRequest::DeviceControlRequest(req) => Self::handle_device_control(req),
            // We never register for directory-change notifications, so the
            // server's watch simply never fires — no response is owed.
            ServerDriveIoRequest::ServerDriveNotifyChangeDirectoryRequest(_) => return Vec::new(),
            // Byte-range locking is not implemented; drives browse and transfer
            // without it, and no reply is expected.
            ServerDriveIoRequest::ServerDriveLockControlRequest(_) => return Vec::new(),
        };
        vec![SvcMessage::from(pdu)]
    }

    fn handle_create(&mut self, req: DeviceCreateRequest) -> RdpdrPdu {
        let io = req.device_io_request.clone();
        let Some(path) = self.resolve(&req.path) else {
            warn!(path = %req.path, "rdpdr create rejected by sandbox");
            return create_error(io, NtStatus::ACCESS_DENIED);
        };

        let exists = path.exists();
        let existing_is_dir = exists && path.is_dir();
        let directory_intent = req
            .create_options
            .contains(CreateOptions::FILE_DIRECTORY_FILE);
        // A directory open of an existing non-directory (or a file open of an
        // existing directory) is a type mismatch the server must be told about,
        // rather than silently mis-registering the handle.
        if exists && directory_intent && !existing_is_dir {
            return create_error(io, NtStatus::NOT_A_DIRECTORY);
        }

        if directory_intent || existing_is_dir {
            self.create_directory(io, path, exists, req.create_disposition)
        } else {
            self.create_file(io, path, exists, &req)
        }
    }

    fn create_directory(
        &mut self,
        io: DeviceIoRequest,
        path: PathBuf,
        exists: bool,
        disposition: CreateDisposition,
    ) -> RdpdrPdu {
        let information = match disposition {
            CreateDisposition::FILE_OPEN | CreateDisposition::FILE_OVERWRITE => {
                if !exists {
                    return create_error(io, NtStatus::NO_SUCH_FILE);
                }
                Information::FILE_OPENED
            }
            CreateDisposition::FILE_CREATE => {
                if exists {
                    return create_error(io, NtStatus::OBJECT_NAME_COLLISION);
                }
                if fs::create_dir(&path).is_err() {
                    return create_error(io, NtStatus::UNSUCCESSFUL);
                }
                Information::FILE_SUPERSEDED
            }
            _ => {
                // FILE_OPEN_IF / FILE_SUPERSEDE / FILE_OVERWRITE_IF: open or create.
                if exists {
                    Information::FILE_OPENED
                } else if fs::create_dir(&path).is_err() {
                    return create_error(io, NtStatus::UNSUCCESSFUL);
                } else {
                    Information::FILE_SUPERSEDED
                }
            }
        };

        let file_id = self.allocate_file_id();
        self.open_files.insert(
            file_id,
            OpenFile {
                path,
                is_dir: true,
                delete_on_close: false,
                listing: None,
            },
        );
        create_ok(io, file_id, information)
    }

    fn create_file(
        &mut self,
        io: DeviceIoRequest,
        path: PathBuf,
        exists: bool,
        req: &DeviceCreateRequest,
    ) -> RdpdrPdu {
        use CreateDisposition as Cd;
        let disposition = req.create_disposition;

        // Presence preconditions per disposition.
        match disposition {
            Cd::FILE_OPEN | Cd::FILE_OVERWRITE if !exists => {
                return create_error(io, NtStatus::NO_SUCH_FILE);
            }
            Cd::FILE_CREATE if exists => {
                return create_error(io, NtStatus::OBJECT_NAME_COLLISION);
            }
            _ => {}
        }

        let needs_create = matches!(
            disposition,
            Cd::FILE_SUPERSEDE | Cd::FILE_CREATE | Cd::FILE_OPEN_IF | Cd::FILE_OVERWRITE_IF
        );
        let needs_truncate = matches!(
            disposition,
            Cd::FILE_SUPERSEDE | Cd::FILE_OVERWRITE | Cd::FILE_OVERWRITE_IF
        );
        let wants_write = needs_create
            || needs_truncate
            || req.desired_access.intersects(
                DesiredAccess::FILE_WRITE_DATA_OR_FILE_ADD_FILE
                    | DesiredAccess::FILE_APPEND_DATA_OR_FILE_ADD_SUBDIRECTORY
                    | DesiredAccess::GENERIC_WRITE
                    | DesiredAccess::GENERIC_ALL,
            );

        let mut options = OpenOptions::new();
        options.read(true);
        if wants_write {
            options.write(true);
        }
        if needs_create {
            options.create(true);
        }
        if disposition == Cd::FILE_CREATE {
            options.create_new(true);
        }
        if needs_truncate {
            options.truncate(true);
        }

        if let Err(e) = options.open(&path) {
            return create_error(io, io_error_to_nt_status(&e));
        }

        let information = if !exists {
            Information::FILE_SUPERSEDED
        } else if needs_truncate {
            Information::FILE_OVERWRITTEN
        } else {
            Information::FILE_OPENED
        };

        let file_id = self.allocate_file_id();
        self.open_files.insert(
            file_id,
            OpenFile {
                path,
                is_dir: false,
                delete_on_close: req
                    .create_options
                    .contains(CreateOptions::FILE_DELETE_ON_CLOSE),
                listing: None,
            },
        );
        create_ok(io, file_id, information)
    }

    fn handle_close(&mut self, req: DeviceCloseRequest) -> RdpdrPdu {
        let io = req.device_io_request;
        if let Some(open) = self.open_files.remove(&io.file_id) {
            if open.delete_on_close {
                let removed = if open.is_dir {
                    fs::remove_dir(&open.path)
                } else {
                    fs::remove_file(&open.path)
                };
                if let Err(e) = removed {
                    debug!(error = %e, path = %open.path.display(), "rdpdr delete-on-close failed");
                }
            }
        }
        RdpdrPdu::DeviceCloseResponse(DeviceCloseResponse {
            device_io_response: DeviceIoResponse::new(io, NtStatus::SUCCESS),
        })
    }

    fn handle_read(&mut self, req: DeviceReadRequest) -> RdpdrPdu {
        let io = req.device_io_request.clone();
        let Some(open) = self.open_files.get(&io.file_id) else {
            return read_error(io, NtStatus::UNSUCCESSFUL);
        };
        match read_at(&open.path, req.offset, req.length) {
            Ok(read_data) => RdpdrPdu::DeviceReadResponse(DeviceReadResponse {
                device_io_reply: DeviceIoResponse::new(io, NtStatus::SUCCESS),
                read_data,
            }),
            Err(e) => read_error(io, io_error_to_nt_status(&e)),
        }
    }

    fn handle_write(&mut self, req: DeviceWriteRequest) -> RdpdrPdu {
        let io = req.device_io_request.clone();
        let Some(open) = self.open_files.get(&io.file_id) else {
            return write_error(io, NtStatus::UNSUCCESSFUL);
        };
        if open.is_dir {
            return write_error(io, NtStatus::ACCESS_DENIED);
        }
        match write_at(&open.path, req.offset, &req.write_data) {
            Ok(length) => RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
                device_io_reply: DeviceIoResponse::new(io, NtStatus::SUCCESS),
                length,
            }),
            Err(e) => write_error(io, io_error_to_nt_status(&e)),
        }
    }

    fn handle_query_information(&mut self, req: ServerDriveQueryInformationRequest) -> RdpdrPdu {
        let io = req.device_io_request.clone();
        let Some(open) = self.open_files.get(&io.file_id) else {
            return query_info_error(io, NtStatus::UNSUCCESSFUL);
        };
        let Ok(metadata) = fs::metadata(&open.path) else {
            return query_info_error(io, NtStatus::NO_SUCH_FILE);
        };

        let buffer = match req.file_info_class_lvl {
            FileInformationClassLevel::FILE_BASIC_INFORMATION => {
                FileInformationClass::Basic(basic_information(&metadata))
            }
            FileInformationClassLevel::FILE_STANDARD_INFORMATION => FileInformationClass::Standard(
                standard_information(&metadata, open.delete_on_close),
            ),
            FileInformationClassLevel::FILE_ATTRIBUTE_TAG_INFORMATION => {
                FileInformationClass::AttributeTag(FileAttributeTagInformation {
                    file_attributes: file_attributes(&metadata),
                    reparse_tag: 0,
                })
            }
            other => {
                debug!(?other, "rdpdr unsupported query-information class");
                return query_info_error(io, NtStatus::NOT_SUPPORTED);
            }
        };

        RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
            device_io_response: DeviceIoResponse::new(io, NtStatus::SUCCESS),
            buffer: Some(buffer),
        })
    }

    fn handle_query_directory(&mut self, req: ServerDriveQueryDirectoryRequest) -> RdpdrPdu {
        let io = req.device_io_request.clone();
        let level = req.file_info_class_lvl.clone();

        let Some(open) = self.open_files.get_mut(&io.file_id) else {
            return query_directory_error(io, NtStatus::UNSUCCESSFUL);
        };

        if req.initial_query != 0 || open.listing.is_none() {
            // The request path is the search path relative to the share root;
            // the actual wildcard is its final component (e.g. `\*` → `*`,
            // `\sub\*.txt` → `*.txt`). Matching against the whole path — as the
            // leading backslash a real server sends would require — would list
            // nothing, so extract the trailing component (defaulting to `*`).
            let pattern = req.path.rsplit(['\\', '/']).next().unwrap_or("*");
            let pattern = if pattern.is_empty() { "*" } else { pattern };
            let entries = build_listing(&open.path, pattern);
            open.listing = Some(DirListing { entries, cursor: 0 });
        }

        let listing = open.listing.as_mut().expect("listing set above");
        let Some(entry) = listing.entries.get(listing.cursor).cloned() else {
            return RdpdrPdu::ClientDriveQueryDirectoryResponse(
                ClientDriveQueryDirectoryResponse {
                    device_io_reply: DeviceIoResponse::new(io, NtStatus::NO_MORE_FILES),
                    buffer: None,
                },
            );
        };
        listing.cursor += 1;

        let buffer = directory_information(&level, &entry);
        RdpdrPdu::ClientDriveQueryDirectoryResponse(ClientDriveQueryDirectoryResponse {
            device_io_reply: DeviceIoResponse::new(io, NtStatus::SUCCESS),
            buffer: Some(buffer),
        })
    }

    fn handle_query_volume_information(
        &self,
        req: ServerDriveQueryVolumeInformationRequest,
    ) -> RdpdrPdu {
        let io = req.device_io_request.clone();
        let buffer = match req.fs_info_class_lvl {
            FileSystemInformationClassLevel::FILE_FS_VOLUME_INFORMATION => {
                FileSystemInformationClass::FileFsVolumeInformation(FileFsVolumeInformation {
                    volume_creation_time: 0,
                    volume_serial_number: 0,
                    supports_objects: Boolean::False,
                    volume_label: "termiHub".to_string(),
                })
            }
            FileSystemInformationClassLevel::FILE_FS_SIZE_INFORMATION => {
                FileSystemInformationClass::FileFsSizeInformation(FileFsSizeInformation {
                    total_alloc_units: FAKE_TOTAL_ALLOC_UNITS,
                    available_alloc_units: FAKE_AVAILABLE_ALLOC_UNITS,
                    sectors_per_alloc_unit: SECTORS_PER_ALLOC_UNIT,
                    bytes_per_sector: BYTES_PER_SECTOR,
                })
            }
            FileSystemInformationClassLevel::FILE_FS_FULL_SIZE_INFORMATION => {
                FileSystemInformationClass::FileFsFullSizeInformation(FileFsFullSizeInformation {
                    total_alloc_units: FAKE_TOTAL_ALLOC_UNITS,
                    caller_available_alloc_units: FAKE_AVAILABLE_ALLOC_UNITS,
                    actual_available_alloc_units: FAKE_AVAILABLE_ALLOC_UNITS,
                    sectors_per_alloc_unit: SECTORS_PER_ALLOC_UNIT,
                    bytes_per_sector: BYTES_PER_SECTOR,
                })
            }
            FileSystemInformationClassLevel::FILE_FS_ATTRIBUTE_INFORMATION => {
                FileSystemInformationClass::FileFsAttributeInformation(FileFsAttributeInformation {
                    file_system_attributes: FileSystemAttributes::FILE_CASE_PRESERVED_NAMES
                        | FileSystemAttributes::FILE_UNICODE_ON_DISK,
                    max_component_name_len: 255,
                    file_system_name: "termiHub".to_string(),
                })
            }
            FileSystemInformationClassLevel::FILE_FS_DEVICE_INFORMATION => {
                FileSystemInformationClass::FileFsDeviceInformation(FileFsDeviceInformation {
                    device_type: FILE_DEVICE_DISK,
                    characteristics: Characteristics::empty(),
                })
            }
            other => {
                debug!(?other, "rdpdr unsupported volume-information class");
                return RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
                    ClientDriveQueryVolumeInformationResponse::new(
                        io,
                        NtStatus::NOT_SUPPORTED,
                        None,
                    ),
                );
            }
        };

        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
            ClientDriveQueryVolumeInformationResponse::new(io, NtStatus::SUCCESS, Some(buffer)),
        )
    }

    fn handle_set_information(&mut self, req: ServerDriveSetInformationRequest) -> RdpdrPdu {
        let io = req.device_io_request.clone();
        let status = match self.open_files.get(&io.file_id) {
            Some(open) => {
                let path = open.path.clone();
                let is_dir = open.is_dir;
                self.apply_set_information(&req.set_buffer, &path, is_dir, io.file_id)
            }
            None => NtStatus::UNSUCCESSFUL,
        };

        match ClientDriveSetInformationResponse::new(&req, status) {
            Ok(response) => RdpdrPdu::ClientDriveSetInformationResponse(response),
            Err(e) => {
                warn!(error = %e, "rdpdr failed to build set-information response");
                RdpdrPdu::EmptyResponse
            }
        }
    }

    fn apply_set_information(
        &mut self,
        buffer: &FileInformationClass,
        path: &PathBuf,
        is_dir: bool,
        file_id: u32,
    ) -> NtStatus {
        match buffer {
            // Times / attributes: accepted but not applied — the minimal
            // behaviour that keeps servers happy without touching the local
            // file's metadata.
            FileInformationClass::Basic(_) => NtStatus::SUCCESS,
            FileInformationClass::EndOfFile(info) => match set_file_len(path, info.end_of_file) {
                Ok(()) => NtStatus::SUCCESS,
                Err(e) => io_error_to_nt_status(&e),
            },
            FileInformationClass::Allocation(info) => {
                match set_file_len(path, info.allocation_size) {
                    Ok(()) => NtStatus::SUCCESS,
                    Err(e) => io_error_to_nt_status(&e),
                }
            }
            FileInformationClass::Disposition(info) => {
                if let Some(open) = self.open_files.get_mut(&file_id) {
                    open.delete_on_close = info.delete_pending != 0;
                }
                NtStatus::SUCCESS
            }
            FileInformationClass::Rename(info) => {
                let Some(target) = self.resolve(&info.file_name) else {
                    return NtStatus::ACCESS_DENIED;
                };
                if target.exists() && info.replace_if_exists != Boolean::True {
                    return NtStatus::OBJECT_NAME_COLLISION;
                }
                match fs::rename(path, &target) {
                    Ok(()) => {
                        if let Some(open) = self.open_files.get_mut(&file_id) {
                            open.path = target;
                            open.is_dir = is_dir;
                        }
                        NtStatus::SUCCESS
                    }
                    Err(e) => io_error_to_nt_status(&e),
                }
            }
            other => {
                debug!(?other, "rdpdr unsupported set-information class");
                NtStatus::NOT_SUPPORTED
            }
        }
    }

    /// FSCTL / IOCTL requests: the redirected drive works without device-control
    /// support, so complete them as unsupported rather than pretending success.
    fn handle_device_control(req: DeviceControlRequest<AnyIoCtlCode>) -> RdpdrPdu {
        RdpdrPdu::DeviceControlResponse(DeviceControlResponse::new(
            req,
            NtStatus::NOT_SUPPORTED,
            None,
        ))
    }
}

impl_as_any!(DriveRedirectBackend);

impl RdpdrBackend for DriveRedirectBackend {
    fn handle_server_device_announce_response(
        &mut self,
        pdu: ServerDeviceAnnounceResponse,
    ) -> PduResult<()> {
        debug!(?pdu, "rdpdr device announce acknowledged");
        Ok(())
    }

    fn handle_scard_call(
        &mut self,
        _req: DeviceControlRequest<ScardIoCtlCode>,
        _call: ScardCall,
    ) -> PduResult<()> {
        // No smartcard device is announced, so a conforming server never calls
        // this; treat it as a no-op rather than an error.
        warn!("rdpdr smartcard call received but no smartcard is redirected");
        Ok(())
    }

    fn handle_drive_io_request(&mut self, req: ServerDriveIoRequest) -> PduResult<Vec<SvcMessage>> {
        Ok(self.dispatch(req))
    }
}

/// Convert an optional [`SystemTime`] to a Windows FILETIME (100-ns ticks since
/// 1601-01-01). Times before the Unix epoch or unavailable collapse to 0.
fn to_filetime(time: Option<SystemTime>) -> i64 {
    let Some(time) = time else { return 0 };
    match time.duration_since(UNIX_EPOCH) {
        Ok(delta) => {
            (delta.as_secs() as i64 + FILETIME_UNIX_EPOCH_DIFF_SECS) * 10_000_000
                + i64::from(delta.subsec_nanos() / 100)
        }
        Err(_) => 0,
    }
}

/// Map filesystem metadata to Windows file attributes.
fn file_attributes(metadata: &Metadata) -> FileAttributes {
    let mut attributes = if metadata.is_dir() {
        FileAttributes::FILE_ATTRIBUTE_DIRECTORY
    } else {
        FileAttributes::FILE_ATTRIBUTE_ARCHIVE
    };
    if metadata.permissions().readonly() {
        attributes |= FileAttributes::FILE_ATTRIBUTE_READONLY;
    }
    attributes
}

fn basic_information(metadata: &Metadata) -> FileBasicInformation {
    let created = to_filetime(metadata.created().ok());
    let accessed = to_filetime(metadata.accessed().ok());
    let modified = to_filetime(metadata.modified().ok());
    FileBasicInformation {
        creation_time: created,
        last_access_time: accessed,
        last_write_time: modified,
        change_time: modified,
        file_attributes: file_attributes(metadata),
    }
}

fn standard_information(metadata: &Metadata, delete_pending: bool) -> FileStandardInformation {
    let size = metadata.len() as i64;
    FileStandardInformation {
        allocation_size: size,
        end_of_file: size,
        number_of_links: 1,
        delete_pending: if delete_pending {
            Boolean::True
        } else {
            Boolean::False
        },
        directory: if metadata.is_dir() {
            Boolean::True
        } else {
            Boolean::False
        },
    }
}

/// Build the requested directory-entry information class for one entry.
fn directory_information(
    level: &FileInformationClassLevel,
    entry: &EnumEntry,
) -> FileInformationClass {
    match *level {
        FileInformationClassLevel::FILE_FULL_DIRECTORY_INFORMATION => {
            FileInformationClass::FullDirectory(FileFullDirectoryInformation::new(
                entry.creation_time,
                entry.last_access_time,
                entry.last_write_time,
                entry.last_write_time,
                entry.size,
                entry.attributes.clone(),
                entry.name.clone(),
            ))
        }
        FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION => {
            FileInformationClass::BothDirectory(FileBothDirectoryInformation::new(
                entry.creation_time,
                entry.last_access_time,
                entry.last_write_time,
                entry.last_write_time,
                entry.size,
                entry.attributes.clone(),
                entry.name.clone(),
            ))
        }
        FileInformationClassLevel::FILE_NAMES_INFORMATION => {
            FileInformationClass::Names(FileNamesInformation::new(entry.name.clone()))
        }
        // FILE_DIRECTORY_INFORMATION and any unexpected level fall back to the
        // base directory-information class.
        _ => FileInformationClass::Directory(FileDirectoryInformation::new(
            entry.creation_time,
            entry.last_access_time,
            entry.last_write_time,
            entry.last_write_time,
            entry.size,
            entry.attributes.clone(),
            entry.name.clone(),
        )),
    }
}

/// Enumerate a directory into wire-ready entries, including the `.` and `..`
/// pseudo-entries Windows expects, filtered by the server's search pattern.
fn build_listing(dir: &PathBuf, pattern: &str) -> Vec<EnumEntry> {
    let mut entries = Vec::new();

    let dir_meta = fs::metadata(dir).ok();
    let dot_entry = |name: &str, meta: &Option<Metadata>| EnumEntry {
        name: name.to_string(),
        attributes: FileAttributes::FILE_ATTRIBUTE_DIRECTORY,
        size: 0,
        creation_time: meta.as_ref().map_or(0, |m| to_filetime(m.created().ok())),
        last_access_time: meta.as_ref().map_or(0, |m| to_filetime(m.accessed().ok())),
        last_write_time: meta.as_ref().map_or(0, |m| to_filetime(m.modified().ok())),
    };

    if wildcard_match(pattern, ".") {
        entries.push(dot_entry(".", &dir_meta));
    }
    if wildcard_match(pattern, "..") {
        entries.push(dot_entry("..", &dir_meta));
    }

    if let Ok(read_dir) = fs::read_dir(dir) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !wildcard_match(pattern, &name) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            entries.push(EnumEntry {
                name,
                attributes: file_attributes(&metadata),
                size: metadata.len() as i64,
                creation_time: to_filetime(metadata.created().ok()),
                last_access_time: to_filetime(metadata.accessed().ok()),
                last_write_time: to_filetime(metadata.modified().ok()),
            });
        }
    }

    entries
}

/// Case-insensitive glob match supporting `*` (any run) and `?` (one char) —
/// the wildcard vocabulary RDP servers use for directory queries. An empty
/// pattern matches everything (some servers send no pattern for a full listing).
fn wildcard_match(pattern: &str, name: &str) -> bool {
    if pattern.is_empty() {
        return true;
    }
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let name: Vec<char> = name.to_lowercase().chars().collect();

    // Iterative wildcard matcher with backtracking on `*`.
    let (mut p, mut n) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = n;
            p += 1;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            mark += 1;
            n = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

/// Read up to `length` bytes from `path` starting at `offset`. A read past EOF
/// yields fewer bytes (an empty vec at EOF), which the protocol allows.
fn read_at(path: &PathBuf, offset: u64, length: u32) -> std::io::Result<Vec<u8>> {
    let mut file = OpenOptions::new().read(true).open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buffer = vec![0u8; length as usize];
    let mut filled = 0usize;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// Write `data` to `path` at `offset`, returning the number of bytes written.
fn write_at(path: &PathBuf, offset: u64, data: &[u8]) -> std::io::Result<u32> {
    let mut file = OpenOptions::new().write(true).open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    file.write_all(data)?;
    Ok(u32::try_from(data.len()).unwrap_or(u32::MAX))
}

/// Truncate or extend a file to `len` bytes (used by end-of-file / allocation
/// set-information).
fn set_file_len(path: &PathBuf, len: i64) -> std::io::Result<()> {
    let file = OpenOptions::new().write(true).open(path)?;
    file.set_len(len.max(0) as u64)
}

/// Map a Rust I/O error to the closest NTSTATUS the server understands.
fn io_error_to_nt_status(error: &std::io::Error) -> NtStatus {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => NtStatus::NO_SUCH_FILE,
        ErrorKind::PermissionDenied => NtStatus::ACCESS_DENIED,
        ErrorKind::AlreadyExists => NtStatus::OBJECT_NAME_COLLISION,
        _ => NtStatus::UNSUCCESSFUL,
    }
}

// --- Small response-builder helpers keeping the handlers terse. ---

fn create_ok(io: DeviceIoRequest, file_id: u32, information: Information) -> RdpdrPdu {
    RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
        device_io_reply: DeviceIoResponse::new(io, NtStatus::SUCCESS),
        file_id,
        information,
    })
}

fn create_error(io: DeviceIoRequest, status: NtStatus) -> RdpdrPdu {
    RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
        device_io_reply: DeviceIoResponse::new(io, status),
        file_id: 0,
        information: Information::empty(),
    })
}

fn read_error(io: DeviceIoRequest, status: NtStatus) -> RdpdrPdu {
    RdpdrPdu::DeviceReadResponse(DeviceReadResponse {
        device_io_reply: DeviceIoResponse::new(io, status),
        read_data: Vec::new(),
    })
}

fn write_error(io: DeviceIoRequest, status: NtStatus) -> RdpdrPdu {
    RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
        device_io_reply: DeviceIoResponse::new(io, status),
        length: 0,
    })
}

fn query_info_error(io: DeviceIoRequest, status: NtStatus) -> RdpdrPdu {
    RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
        device_io_response: DeviceIoResponse::new(io, status),
        buffer: None,
    })
}

fn query_directory_error(io: DeviceIoRequest, status: NtStatus) -> RdpdrPdu {
    RdpdrPdu::ClientDriveQueryDirectoryResponse(ClientDriveQueryDirectoryResponse {
        device_io_reply: DeviceIoResponse::new(io, status),
        buffer: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::rdpdr::pdu::efs::{
        FileRenameInformation, MajorFunction, MinorFunction, SharedAccess,
    };

    fn backend_with_root() -> (DriveRedirectBackend, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        (DriveRedirectBackend::new(root), dir)
    }

    fn io_request(file_id: u32, major: MajorFunction) -> DeviceIoRequest {
        DeviceIoRequest {
            device_id: 1,
            file_id,
            completion_id: 7,
            major_function: major,
            minor_function: MinorFunction::from(0u32),
        }
    }

    fn create_request(
        path: &str,
        disposition: CreateDisposition,
        options: CreateOptions,
    ) -> DeviceCreateRequest {
        DeviceCreateRequest {
            device_io_request: io_request(0, MajorFunction::Create),
            desired_access: DesiredAccess::GENERIC_ALL,
            allocation_size: 0,
            file_attributes: FileAttributes::empty(),
            shared_access: SharedAccess::empty(),
            create_disposition: disposition,
            create_options: options,
            path: path.to_string(),
        }
    }

    fn create_status(pdu: &RdpdrPdu) -> NtStatus {
        match pdu {
            RdpdrPdu::DeviceCreateResponse(r) => r.device_io_reply.io_status,
            other => panic!("expected DeviceCreateResponse, got {other:?}"),
        }
    }

    /// Create through the backend and return the assigned file_id (the largest
    /// key in the open table after a successful create).
    fn create_ok_id(
        backend: &mut DriveRedirectBackend,
        path: &str,
        disposition: CreateDisposition,
        options: CreateOptions,
    ) -> u32 {
        let pdu = backend.handle_create(create_request(path, disposition, options));
        assert_eq!(
            create_status(&pdu),
            NtStatus::SUCCESS,
            "create should succeed"
        );
        *backend.open_files.keys().max().unwrap()
    }

    #[test]
    fn resolve_rejects_parent_traversal() {
        let (backend, _dir) = backend_with_root();
        assert!(backend.resolve("..\\etc\\passwd").is_none());
        assert!(backend.resolve("sub\\..\\..\\secret").is_none());
        assert!(backend.resolve("a\\b\\..").is_none());
    }

    #[test]
    fn resolve_rejects_drive_letters_and_nul() {
        let (backend, _dir) = backend_with_root();
        assert!(backend.resolve("C:\\Windows").is_none());
        assert!(backend.resolve("weird\0name").is_none());
    }

    #[test]
    fn resolve_allows_nested_paths_within_root() {
        let (backend, dir) = backend_with_root();
        fs::create_dir_all(dir.path().join("a/b")).unwrap();
        let resolved = backend.resolve("a\\b").unwrap();
        assert!(resolved.starts_with(&backend.root));
        assert!(resolved.ends_with("b"));
        // Root itself resolves back to the root.
        assert_eq!(backend.resolve("\\").unwrap(), backend.root);
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("*", "."));
        assert!(wildcard_match("", "anything"));
        assert!(wildcard_match("*.txt", "notes.txt"));
        assert!(!wildcard_match("*.txt", "notes.md"));
        assert!(wildcard_match("file?.dat", "file1.dat"));
        assert!(!wildcard_match("file?.dat", "file12.dat"));
        assert!(wildcard_match("READ*", "readme")); // case-insensitive
    }

    #[test]
    fn create_open_read_write_close_round_trip() {
        let (mut backend, dir) = backend_with_root();
        let file_id = create_ok_id(
            &mut backend,
            "hello.txt",
            CreateDisposition::FILE_OVERWRITE_IF,
            CreateOptions::empty(),
        );
        assert!(dir.path().join("hello.txt").exists());

        // Write bytes at offset 0.
        let write = backend.handle_write(DeviceWriteRequest {
            device_io_request: io_request(file_id, MajorFunction::Write),
            offset: 0,
            write_data: b"termiHub".to_vec(),
        });
        match write {
            RdpdrPdu::DeviceWriteResponse(r) => {
                assert_eq!(r.device_io_reply.io_status, NtStatus::SUCCESS);
                assert_eq!(r.length, 8);
            }
            other => panic!("expected DeviceWriteResponse, got {other:?}"),
        }
        assert_eq!(fs::read(dir.path().join("hello.txt")).unwrap(), b"termiHub");

        // Read them back.
        let read = backend.handle_read(DeviceReadRequest {
            device_io_request: io_request(file_id, MajorFunction::Read),
            length: 8,
            offset: 0,
        });
        match read {
            RdpdrPdu::DeviceReadResponse(r) => assert_eq!(r.read_data, b"termiHub"),
            other => panic!("expected DeviceReadResponse, got {other:?}"),
        }

        // Close (no delete).
        backend.handle_close(DeviceCloseRequest {
            device_io_request: io_request(file_id, MajorFunction::Close),
        });
        assert!(!backend.open_files.contains_key(&file_id));
        assert!(dir.path().join("hello.txt").exists());
    }

    #[test]
    fn create_with_file_open_on_missing_file_fails() {
        let (mut backend, _dir) = backend_with_root();
        let pdu = backend.handle_create(create_request(
            "missing.txt",
            CreateDisposition::FILE_OPEN,
            CreateOptions::empty(),
        ));
        assert_eq!(create_status(&pdu), NtStatus::NO_SUCH_FILE);
        assert!(backend.open_files.is_empty());
    }

    #[test]
    fn opening_a_file_as_a_directory_is_rejected() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("plain.txt"), b"x").unwrap();
        let pdu = backend.handle_create(create_request(
            "plain.txt",
            CreateDisposition::FILE_OPEN,
            CreateOptions::FILE_DIRECTORY_FILE,
        ));
        assert_eq!(create_status(&pdu), NtStatus::NOT_A_DIRECTORY);
        assert!(backend.open_files.is_empty());
    }

    #[test]
    fn create_file_with_create_disposition_collides_when_exists() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("dup.txt"), b"x").unwrap();
        let pdu = backend.handle_create(create_request(
            "dup.txt",
            CreateDisposition::FILE_CREATE,
            CreateOptions::empty(),
        ));
        assert_eq!(create_status(&pdu), NtStatus::OBJECT_NAME_COLLISION);
    }

    #[test]
    fn delete_on_close_removes_the_file() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("temp.bin"), b"data").unwrap();
        let file_id = create_ok_id(
            &mut backend,
            "temp.bin",
            CreateDisposition::FILE_OPEN,
            CreateOptions::FILE_DELETE_ON_CLOSE,
        );
        backend.handle_close(DeviceCloseRequest {
            device_io_request: io_request(file_id, MajorFunction::Close),
        });
        assert!(!dir.path().join("temp.bin").exists());
    }

    #[test]
    fn query_directory_lists_entries_including_dot_and_dotdot() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("one.txt"), b"1").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let file_id = create_ok_id(
            &mut backend,
            "\\",
            CreateDisposition::FILE_OPEN,
            CreateOptions::FILE_DIRECTORY_FILE,
        );

        // Enumerate until NO_MORE_FILES.
        let mut names = Vec::new();
        let mut initial = 1u8;
        loop {
            let pdu = backend.handle_query_directory(ServerDriveQueryDirectoryRequest {
                device_io_request: io_request(file_id, MajorFunction::DirectoryControl),
                file_info_class_lvl: FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION,
                initial_query: initial,
                // A real server sends the search pattern as a path with a
                // leading backslash — the handler must extract the trailing
                // `*`, not match against the whole `\*`.
                path: "\\*".to_string(),
            });
            initial = 0;
            match pdu {
                RdpdrPdu::ClientDriveQueryDirectoryResponse(r) => match r.device_io_reply.io_status
                {
                    NtStatus::NO_MORE_FILES => break,
                    NtStatus::SUCCESS => {
                        if let Some(FileInformationClass::BothDirectory(info)) = r.buffer {
                            names.push(info.file_name);
                        }
                    }
                    other => panic!("unexpected status {other:?}"),
                },
                other => panic!("expected query-directory response, got {other:?}"),
            }
        }
        assert!(names.contains(&".".to_string()));
        assert!(names.contains(&"..".to_string()));
        assert!(names.contains(&"one.txt".to_string()));
        assert!(names.contains(&"subdir".to_string()));
    }

    #[test]
    fn query_directory_honors_a_specific_name_pattern() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("keep.txt"), b"1").unwrap();
        fs::write(dir.path().join("skip.txt"), b"2").unwrap();

        let file_id = create_ok_id(
            &mut backend,
            "\\",
            CreateDisposition::FILE_OPEN,
            CreateOptions::FILE_DIRECTORY_FILE,
        );

        // The server queries for one specific file: `\keep.txt`.
        let mut names = Vec::new();
        let mut initial = 1u8;
        loop {
            let pdu = backend.handle_query_directory(ServerDriveQueryDirectoryRequest {
                device_io_request: io_request(file_id, MajorFunction::DirectoryControl),
                file_info_class_lvl: FileInformationClassLevel::FILE_DIRECTORY_INFORMATION,
                initial_query: initial,
                path: "\\keep.txt".to_string(),
            });
            initial = 0;
            match pdu {
                RdpdrPdu::ClientDriveQueryDirectoryResponse(r) => match r.device_io_reply.io_status
                {
                    NtStatus::NO_MORE_FILES => break,
                    NtStatus::SUCCESS => {
                        if let Some(FileInformationClass::Directory(info)) = r.buffer {
                            names.push(info.file_name);
                        }
                    }
                    other => panic!("unexpected status {other:?}"),
                },
                other => panic!("expected query-directory response, got {other:?}"),
            }
        }
        assert_eq!(names, vec!["keep.txt".to_string()]);
    }

    #[test]
    fn query_information_reports_size_and_directory_flag() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("sized.dat"), vec![0u8; 42]).unwrap();
        let file_id = create_ok_id(
            &mut backend,
            "sized.dat",
            CreateDisposition::FILE_OPEN,
            CreateOptions::empty(),
        );
        let pdu = backend.handle_query_information(ServerDriveQueryInformationRequest {
            device_io_request: io_request(file_id, MajorFunction::QueryInformation),
            file_info_class_lvl: FileInformationClassLevel::FILE_STANDARD_INFORMATION,
        });
        match pdu {
            RdpdrPdu::ClientDriveQueryInformationResponse(r) => {
                assert_eq!(r.device_io_response.io_status, NtStatus::SUCCESS);
                match r.buffer {
                    Some(FileInformationClass::Standard(info)) => {
                        assert_eq!(info.end_of_file, 42);
                        assert_eq!(info.directory, Boolean::False);
                    }
                    other => panic!("expected standard information, got {other:?}"),
                }
            }
            other => panic!("expected query-information response, got {other:?}"),
        }
    }

    #[test]
    fn rename_moves_the_file_within_the_sandbox() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("old.txt"), b"x").unwrap();
        let file_id = create_ok_id(
            &mut backend,
            "old.txt",
            CreateDisposition::FILE_OPEN,
            CreateOptions::empty(),
        );
        let status = backend.apply_set_information(
            &FileInformationClass::Rename(FileRenameInformation {
                replace_if_exists: Boolean::True,
                file_name: "new.txt".to_string(),
            }),
            &dir.path().join("old.txt"),
            false,
            file_id,
        );
        assert_eq!(status, NtStatus::SUCCESS);
        assert!(!dir.path().join("old.txt").exists());
        assert!(dir.path().join("new.txt").exists());
    }

    #[test]
    fn read_beyond_eof_returns_available_bytes() {
        let (mut backend, dir) = backend_with_root();
        fs::write(dir.path().join("short.bin"), b"ab").unwrap();
        let file_id = create_ok_id(
            &mut backend,
            "short.bin",
            CreateDisposition::FILE_OPEN,
            CreateOptions::empty(),
        );
        let pdu = backend.handle_read(DeviceReadRequest {
            device_io_request: io_request(file_id, MajorFunction::Read),
            length: 100,
            offset: 0,
        });
        match pdu {
            RdpdrPdu::DeviceReadResponse(r) => assert_eq!(r.read_data, b"ab"),
            other => panic!("expected read response, got {other:?}"),
        }
    }
}
