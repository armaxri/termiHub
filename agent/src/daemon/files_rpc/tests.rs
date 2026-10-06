//! Frame shapes, chunking, upload collection and the reply channel of the
//! daemon file protocol (#3242).

use super::*;
use std::sync::Mutex as StdMutex;

/// An in-memory file tree standing in for a session backend's browser.
#[derive(Default)]
struct MemBrowser {
    files: StdMutex<HashMap<String, Vec<u8>>>,
    /// Whether it offers ranged access (#3587).
    ranges: bool,
}

impl MemBrowser {
    fn ranged() -> Self {
        Self {
            ranges: true,
            ..Self::default()
        }
    }
}

#[async_trait::async_trait]
impl RangedFileAccess for MemBrowser {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        let files = self.files.lock().unwrap();
        let data = files
            .get(path)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        let start = (offset as usize).min(data.len());
        let end = (start + len as usize).min(data.len());
        Ok(data[start..end].to_vec())
    }
    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        let mut files = self.files.lock().unwrap();
        let file = files.entry(path.into()).or_default();
        if offset == 0 {
            file.clear();
        } else if file.len() as u64 != offset {
            return Err(termihub_core::files::ranged::offset_mismatch(
                path,
                file.len() as u64,
                offset,
            ));
        }
        file.extend_from_slice(data);
        Ok(())
    }
}

#[async_trait::async_trait]
impl FileBrowser for MemBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .keys()
            .filter(|p| p.starts_with(path))
            .map(|p| FileEntry {
                name: p.clone(),
                path: p.clone(),
                ..FileEntry::default()
            })
            .collect())
    }
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| FileError::NotFound(path.into()))
    }
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), data.to_vec());
        Ok(())
    }
    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }
    async fn rename(&self, _from: &str, _to: &str) -> Result<(), FileError> {
        Err(FileError::PermissionDenied("read-only share".into()))
    }
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let size = self
            .files
            .lock()
            .unwrap()
            .get(path)
            .map(|d| d.len() as u64)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        Ok(FileEntry {
            name: path.into(),
            path: path.into(),
            size,
            ..FileEntry::default()
        })
    }
    async fn mkdir(&self, _path: &str) -> Result<(), FileError> {
        Ok(())
    }
    async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn set_owner(
        &self,
        _path: &str,
        _uid: Option<u32>,
        _gid: Option<u32>,
    ) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn create_symlink(&self, _target: &str, _link_path: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn copy(&self, _src: &str, _dest: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    fn ranged(&self) -> Option<&dyn RangedFileAccess> {
        self.ranges.then_some(self as &dyn RangedFileAccess)
    }
}

fn write_request(id: u64, size: u64) -> FileRequest {
    FileRequest {
        id,
        op: FileOp::Write {
            path: "/f".into(),
            size,
        },
    }
}

// ── Frame shapes ────────────────────────────────────────────────────

#[test]
fn requests_serialize_as_flat_tagged_json() {
    let request = FileRequest {
        id: 7,
        op: FileOp::Rename {
            from: "/a".into(),
            to: "/b".into(),
        },
    };
    let v = serde_json::to_value(&request).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"id": 7, "op": "rename", "from": "/a", "to": "/b"})
    );
    let back: FileRequest = serde_json::from_value(v).unwrap();
    assert_eq!(back, request);

    let write = serde_json::to_value(write_request(3, 10)).unwrap();
    assert_eq!(
        write,
        serde_json::json!({"id": 3, "op": "write", "path": "/f", "size": 10})
    );
    let owner = serde_json::to_value(FileRequest {
        id: 1,
        op: FileOp::SetOwner {
            path: "/p".into(),
            uid: Some(0),
            gid: None,
        },
    })
    .unwrap();
    assert_eq!(owner["op"], "set_owner");
    assert!(owner["gid"].is_null());
}

#[test]
fn responses_round_trip_every_outcome() {
    let outcomes = [
        FileOutcome::Listed {
            entries: vec![FileEntry {
                name: "a".into(),
                ..FileEntry::default()
            }],
        },
        FileOutcome::Stat {
            entry: FileEntry::default(),
        },
        FileOutcome::Read { size: 12 },
        FileOutcome::Done,
        FileOutcome::Failed {
            error: WireFileError::TooLarge { size: 9, limit: 8 },
        },
    ];
    for outcome in outcomes {
        let response = FileResponse { id: 5, outcome };
        let bytes = serde_json::to_vec(&response).unwrap();
        let back: FileResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.id, 5);
        assert_eq!(
            serde_json::to_value(&back.outcome).unwrap(),
            serde_json::to_value(&response.outcome).unwrap()
        );
    }
}

#[test]
fn file_errors_cross_the_socket_typed() {
    let cases = [
        FileError::NotFound("/x".into()),
        FileError::PermissionDenied("nope".into()),
        FileError::OperationFailed("boom".into()),
        FileError::TooLarge { size: 2, limit: 1 },
        FileError::NotSupported,
    ];
    for error in cases {
        let text = error.to_string();
        let wire: WireFileError = error.into();
        let json = serde_json::to_vec(&wire).unwrap();
        let back: FileError = serde_json::from_slice::<WireFileError>(&json)
            .unwrap()
            .into();
        assert_eq!(back.to_string(), text);
    }
    let io: WireFileError = FileError::Io(std::io::Error::other("disk gone")).into();
    let back: FileError = io.into();
    assert!(matches!(back, FileError::Io(_)));
    assert!(back.to_string().contains("disk gone"));
}

#[test]
fn chunks_carry_their_request_id() {
    let payload = encode_chunk(0x0102_0304_0506_0708, b"abc");
    assert_eq!(&payload[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(
        decode_chunk(&payload),
        Some((0x0102_0304_0506_0708, &b"abc"[..]))
    );
    assert_eq!(decode_chunk(&encode_chunk(9, b"")), Some((9, &b""[..])));
    assert_eq!(decode_chunk(&[1, 2, 3]), None);
}

#[test]
fn frames_encode_to_their_message_types() {
    let (ty, payload) = FileFrame::Chunk {
        id: 4,
        data: vec![9; 3],
    }
    .encode()
    .unwrap();
    assert_eq!(ty, MSG_FILE_READ_DATA);
    assert_eq!(decode_chunk(&payload), Some((4, &[9u8, 9, 9][..])));

    let (ty, payload) = FileFrame::Reply(FileResponse {
        id: 4,
        outcome: FileOutcome::Done,
    })
    .encode()
    .unwrap();
    assert_eq!(ty, MSG_FILE_RESPONSE);
    let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(v["outcome"]["status"], "done");
}

// ── Daemon side ─────────────────────────────────────────────────────

#[tokio::test]
async fn serve_runs_each_operation_through_the_browser() {
    let browser = MemBrowser::default();
    let (outcome, _) = serve(
        &browser,
        FileOp::Write {
            path: "/a".into(),
            size: 2,
        },
        b"hi".to_vec(),
    )
    .await;
    assert!(matches!(outcome, FileOutcome::Done));

    let (outcome, data) = serve(&browser, FileOp::Read { path: "/a".into() }, Vec::new()).await;
    assert!(matches!(outcome, FileOutcome::Read { size: 2 }));
    assert_eq!(data.as_deref(), Some(&b"hi"[..]));

    let (outcome, _) = serve(&browser, FileOp::Stat { path: "/a".into() }, Vec::new()).await;
    assert!(matches!(outcome, FileOutcome::Stat { entry } if entry.size == 2));

    let (outcome, _) = serve(&browser, FileOp::List { path: "/".into() }, Vec::new()).await;
    assert!(matches!(outcome, FileOutcome::Listed { entries } if entries.len() == 1));

    let (outcome, _) = serve(
        &browser,
        FileOp::Rename {
            from: "/a".into(),
            to: "/b".into(),
        },
        Vec::new(),
    )
    .await;
    assert!(matches!(
        outcome,
        FileOutcome::Failed {
            error: WireFileError::PermissionDenied { .. }
        }
    ));

    let (outcome, data) = serve(
        &browser,
        FileOp::Read {
            path: "/nope".into(),
        },
        Vec::new(),
    )
    .await;
    assert!(matches!(
        outcome,
        FileOutcome::Failed {
            error: WireFileError::NotFound { .. }
        }
    ));
    assert!(data.is_none());
}

/// A backend that never answers is cut off by the daemon's own timeout, as a
/// typed failure rather than a hung worker.
#[tokio::test(start_paused = true)]
async fn serve_times_out_a_hung_backend() {
    struct Hung;
    #[async_trait::async_trait]
    impl FileBrowser for Hung {
        async fn list_dir(&self, _path: &str) -> Result<Vec<FileEntry>, FileError> {
            std::future::pending().await
        }
        async fn read_file(&self, _path: &str) -> Result<Vec<u8>, FileError> {
            std::future::pending().await
        }
        async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), FileError> {
            std::future::pending().await
        }
        async fn delete(&self, _path: &str) -> Result<(), FileError> {
            std::future::pending().await
        }
        async fn rename(&self, _from: &str, _to: &str) -> Result<(), FileError> {
            std::future::pending().await
        }
        async fn stat(&self, _path: &str) -> Result<FileEntry, FileError> {
            std::future::pending().await
        }
        async fn mkdir(&self, _path: &str) -> Result<(), FileError> {
            std::future::pending().await
        }
        async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<(), FileError> {
            std::future::pending().await
        }
        async fn set_owner(
            &self,
            _path: &str,
            _uid: Option<u32>,
            _gid: Option<u32>,
        ) -> Result<(), FileError> {
            std::future::pending().await
        }
        async fn create_symlink(&self, _target: &str, _link_path: &str) -> Result<(), FileError> {
            std::future::pending().await
        }
        async fn copy(&self, _src: &str, _dest: &str) -> Result<(), FileError> {
            std::future::pending().await
        }
    }
    let (outcome, _) = serve(&Hung, FileOp::List { path: "/".into() }, Vec::new()).await;
    match outcome {
        FileOutcome::Failed {
            error: WireFileError::OperationFailed { message },
        } => assert!(message.contains("timed out"), "{message}"),
        other => panic!("expected a timeout, got {other:?}"),
    }
}

/// The worker streams a read's bytes in `CHUNK_SIZE` slices, in order, before
/// its reply — and serves requests one after the other.
#[tokio::test]
async fn the_worker_streams_read_chunks_before_the_reply() {
    let browser = Arc::new(MemBrowser::default());
    let contents: Vec<u8> = (0..(CHUNK_SIZE * 2 + 100)).map(|i| i as u8).collect();
    browser
        .files
        .lock()
        .unwrap()
        .insert("/big".into(), contents.clone());
    let (events_tx, mut events_rx) = mpsc::channel(EVENT_CAPACITY);
    let jobs = spawn_file_worker(browser, events_tx);

    jobs.send(FileJob {
        gen: 3,
        request: FileRequest {
            id: 11,
            op: FileOp::Read {
                path: "/big".into(),
            },
        },
        data: Vec::new(),
    })
    .await
    .unwrap();

    let mut received = Vec::new();
    let mut chunks = 0;
    loop {
        let (gen, frame) = events_rx.recv().await.expect("frame");
        assert_eq!(gen, 3, "frames are tagged with the asking connection");
        match frame {
            FileFrame::Chunk { id, data } => {
                assert_eq!(id, 11);
                assert!(data.len() <= CHUNK_SIZE);
                chunks += 1;
                received.extend(data);
            }
            FileFrame::Reply(response) => {
                assert_eq!(response.id, 11);
                assert!(
                    matches!(response.outcome, FileOutcome::Read { size } if size as usize == contents.len())
                );
                break;
            }
        }
    }
    assert_eq!(chunks, 3);
    assert_eq!(received, contents);
}

// ── Upload collection ───────────────────────────────────────────────

#[test]
fn an_upload_completes_once_all_its_data_arrived() {
    let mut uploads = Uploads::default();
    assert!(matches!(
        uploads.begin(2, write_request(1, 5)),
        UploadStep::Pending
    ));
    assert!(matches!(
        uploads.append(&encode_chunk(1, b"he")),
        UploadStep::Pending
    ));
    match uploads.append(&encode_chunk(1, b"llo")) {
        UploadStep::Complete(job) => {
            assert_eq!(job.gen, 2);
            assert_eq!(job.request.id, 1);
            assert_eq!(job.data, b"hello");
        }
        other => panic!("expected completion, got {other:?}"),
    }
    assert_eq!(uploads.pending_len(), 0);
}

#[test]
fn an_empty_write_and_other_operations_complete_at_once() {
    let mut uploads = Uploads::default();
    assert!(matches!(
        uploads.begin(1, write_request(1, 0)),
        UploadStep::Complete(job) if job.data.is_empty()
    ));
    let list = FileRequest {
        id: 2,
        op: FileOp::List { path: "/".into() },
    };
    assert!(matches!(uploads.begin(1, list), UploadStep::Complete(_)));
    assert_eq!(uploads.pending_len(), 0);
}

#[test]
fn an_oversized_or_overflowing_upload_is_refused() {
    let mut uploads = Uploads::default();
    match uploads.begin(1, write_request(1, MAX_TRANSFER_BYTES + 1)) {
        UploadStep::Refused(r) => assert!(matches!(
            r.outcome,
            FileOutcome::Failed {
                error: WireFileError::TooLarge { .. }
            }
        )),
        other => panic!("expected refusal, got {other:?}"),
    }

    assert!(matches!(
        uploads.begin(1, write_request(2, 3)),
        UploadStep::Pending
    ));
    match uploads.append(&encode_chunk(2, b"four")) {
        UploadStep::Refused(r) => assert_eq!(r.id, 2),
        other => panic!("expected refusal, got {other:?}"),
    }
    assert_eq!(uploads.pending_len(), 0, "the refused upload is dropped");
    // Its trailing data is ignored.
    assert!(matches!(
        uploads.append(&encode_chunk(2, b"x")),
        UploadStep::Pending
    ));
}

#[test]
fn concurrent_uploads_are_bounded_and_cleared_with_their_connection() {
    let mut uploads = Uploads::default();
    for id in 0..MAX_PENDING_UPLOADS as u64 {
        assert!(matches!(
            uploads.begin(1, write_request(id, 10)),
            UploadStep::Pending
        ));
    }
    assert!(matches!(
        uploads.begin(1, write_request(99, 10)),
        UploadStep::Refused(r) if r.id == 99
    ));
    uploads.clear();
    assert_eq!(uploads.pending_len(), 0);
    assert!(matches!(
        uploads.begin(2, write_request(99, 10)),
        UploadStep::Pending
    ));
}

// ── Worker side ─────────────────────────────────────────────────────

#[tokio::test]
async fn the_channel_assembles_read_chunks_into_the_reply() {
    let channel = FileChannel::default();
    let (id, rx) = channel.register();
    channel.deliver_chunk(&encode_chunk(id, b"hel"));
    channel.deliver_chunk(&encode_chunk(id, b"lo"));
    // A chunk for another request is ignored.
    channel.deliver_chunk(&encode_chunk(id + 100, b"zzz"));
    channel.deliver(
        &serde_json::to_vec(&FileResponse {
            id,
            outcome: FileOutcome::Read { size: 5 },
        })
        .unwrap(),
    );
    let (outcome, data) = rx.await.expect("reply");
    assert!(matches!(outcome, FileOutcome::Read { size: 5 }));
    assert_eq!(data, b"hello");
    assert_eq!(channel.pending_len(), 0);
}

#[tokio::test]
async fn malformed_and_unknown_replies_are_dropped() {
    let channel = FileChannel::default();
    let (_id, mut rx) = channel.register();
    channel.deliver(b"not json");
    channel.deliver(
        &serde_json::to_vec(&FileResponse {
            id: 12345,
            outcome: FileOutcome::Done,
        })
        .unwrap(),
    );
    channel.deliver_chunk(&[1, 2]);
    assert!(rx.try_recv().is_err(), "nothing was delivered");
    assert_eq!(channel.pending_len(), 1);
    channel.fail_all();
    assert_eq!(channel.pending_len(), 0);
    assert!(rx.await.is_err(), "failing all closes the waiter");
}

#[test]
fn the_channel_tracks_support() {
    let channel = FileChannel::default();
    assert!(!channel.supported());
    channel.set_supported(true);
    assert!(channel.supported());
}

#[test]
fn only_content_operations_are_transfers() {
    assert!(FileOp::Read { path: "/".into() }.is_transfer());
    assert!(FileOp::Write {
        path: "/".into(),
        size: 1
    }
    .is_transfer());
    assert!(FileOp::Copy {
        src: "/a".into(),
        dest: "/b".into()
    }
    .is_transfer());
    assert!(!FileOp::List { path: "/".into() }.is_transfer());
    assert!(!FileOp::Mkdir { path: "/".into() }.is_transfer());
}

// ── Ranged requests (#3587) ─────────────────────────────────────────

#[test]
fn range_requests_serialize_as_flat_tagged_json() {
    let read = FileRequest {
        id: 4,
        op: FileOp::ReadRange {
            path: "/f".into(),
            offset: 9,
            length: 3,
        },
    };
    let v = serde_json::to_value(&read).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"id": 4, "op": "read_range", "path": "/f", "offset": 9, "length": 3})
    );
    assert_eq!(serde_json::from_value::<FileRequest>(v).unwrap(), read);

    let write = FileRequest {
        id: 5,
        op: FileOp::WriteRange {
            path: "/f".into(),
            offset: 9,
            size: 2,
        },
    };
    let v = serde_json::to_value(&write).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"id": 5, "op": "write_range", "path": "/f", "offset": 9, "size": 2})
    );
    assert_eq!(serde_json::from_value::<FileRequest>(v).unwrap(), write);
}

#[tokio::test]
async fn serve_runs_ranged_slices_through_the_browsers_ranged_access() {
    let browser = MemBrowser::ranged();
    let write = |offset, size| FileOp::WriteRange {
        path: "/f".into(),
        offset,
        size,
    };
    let (outcome, _) = serve(&browser, write(0, 3), b"abc".to_vec()).await;
    assert!(matches!(outcome, FileOutcome::Done), "{outcome:?}");
    let (outcome, _) = serve(&browser, write(3, 3), b"def".to_vec()).await;
    assert!(matches!(outcome, FileOutcome::Done), "{outcome:?}");
    // A slice that would not land at the end is refused, typed.
    let (outcome, _) = serve(&browser, write(2, 1), b"X".to_vec()).await;
    assert!(matches!(
        outcome,
        FileOutcome::Failed {
            error: WireFileError::OperationFailed { .. }
        }
    ));

    let read = |offset, length| FileOp::ReadRange {
        path: "/f".into(),
        offset,
        length,
    };
    let (outcome, data) = serve(&browser, read(2, 3), Vec::new()).await;
    assert!(matches!(outcome, FileOutcome::Read { size: 3 }));
    assert_eq!(data.as_deref(), Some(&b"cde"[..]));
    let (outcome, data) = serve(&browser, read(5, 9), Vec::new()).await;
    assert!(matches!(outcome, FileOutcome::Read { size: 1 }));
    assert_eq!(data.as_deref(), Some(&b"f"[..]));
}

#[tokio::test]
async fn serve_refuses_ranged_slices_on_a_backend_without_them() {
    let browser = MemBrowser::default();
    let (outcome, data) = serve(
        &browser,
        FileOp::ReadRange {
            path: "/f".into(),
            offset: 0,
            length: 4,
        },
        Vec::new(),
    )
    .await;
    assert!(matches!(
        outcome,
        FileOutcome::Failed {
            error: WireFileError::NotSupported
        }
    ));
    assert!(data.is_none());
    let (outcome, _) = serve(
        &browser,
        FileOp::WriteRange {
            path: "/f".into(),
            offset: 0,
            size: 1,
        },
        b"x".to_vec(),
    )
    .await;
    assert!(matches!(
        outcome,
        FileOutcome::Failed {
            error: WireFileError::NotSupported
        }
    ));
    assert!(browser.files.lock().unwrap().is_empty());
}

#[test]
fn a_ranged_write_collects_its_data_like_a_write() {
    let mut uploads = Uploads::default();
    let request = FileRequest {
        id: 8,
        op: FileOp::WriteRange {
            path: "/f".into(),
            offset: 100,
            size: 4,
        },
    };
    assert!(matches!(uploads.begin(1, request), UploadStep::Pending));
    match uploads.append(&encode_chunk(8, b"data")) {
        UploadStep::Complete(job) => assert_eq!(job.data, b"data"),
        other => panic!("expected completion, got {other:?}"),
    }
}

#[test]
fn the_channel_tracks_ranged_support_separately() {
    let channel = FileChannel::default();
    assert!(!channel.ranges_supported());
    channel.set_ranges_supported(true);
    assert!(channel.ranges_supported());
    channel.set_ranges_supported(false);
    assert!(!channel.ranges_supported());
}

#[test]
fn ranged_operations_are_transfers() {
    assert!(FileOp::ReadRange {
        path: "/".into(),
        offset: 0,
        length: 1
    }
    .is_transfer());
    assert!(FileOp::WriteRange {
        path: "/".into(),
        offset: 0,
        size: 1
    }
    .is_transfer());
}
