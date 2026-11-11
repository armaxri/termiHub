//! The shared in-memory [`ProjectionSink`] for projection tests (#5369).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::projection::{DiffFrame, ProjectionError, ProjectionFrame, ProjectionSink};

/// An in-memory [`ProjectionSink`] that records every delivered frame, in
/// delivery order, and can be killed to simulate a dead subscriber (a closed
/// channel or socket): a killed sink refuses every later delivery with
/// [`ProjectionError::SinkClosed`].
pub(crate) struct RecordingSink {
    frames: Mutex<Vec<ProjectionFrame>>,
    alive: AtomicBool,
}

impl RecordingSink {
    /// A live sink that has received nothing yet.
    pub(crate) fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
        }
    }

    /// Kill the sink: every later delivery fails as a dead subscriber would.
    pub(crate) fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    /// Every frame this sink received, snapshots and diffs, in delivery order.
    pub(crate) fn frames(&self) -> Vec<ProjectionFrame> {
        self.frames.lock().unwrap().clone()
    }

    /// Every diff this sink received, in delivery order.
    pub(crate) fn diffs(&self) -> Vec<DiffFrame> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|f| match f {
                ProjectionFrame::Diff(d) => Some(d.clone()),
                ProjectionFrame::Snapshot(_) => None,
            })
            .collect()
    }
}

impl Default for RecordingSink {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectionSink for RecordingSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(ProjectionError::SinkClosed("test sink killed".into()));
        }
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
}

mod tests {
    use super::*;
    use crate::projection::SnapshotFrame;

    #[test]
    fn a_killed_sink_refuses_delivery_and_keeps_what_it_had() {
        let sink = RecordingSink::new();
        let frame = ProjectionFrame::Snapshot(SnapshotFrame {
            kind: Default::default(),
            region: "r".into(),
            version: 1,
            view: serde_json::json!({}),
        });
        sink.deliver(&frame).unwrap();
        sink.kill();
        assert!(matches!(
            sink.deliver(&frame),
            Err(ProjectionError::SinkClosed(_))
        ));
        assert_eq!(sink.frames().len(), 1);
        assert!(sink.diffs().is_empty());
    }
}
