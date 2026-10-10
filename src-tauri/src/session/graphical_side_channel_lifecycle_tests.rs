//! The browse side channel follows the graphical session's own lifecycle
//! (#4384): an automatic reconnect re-opens it on the new backend, and the
//! session ending — a disconnect, or resting for good — drops it. Driven
//! through the manager against this file's parent's fake backend, with a fake
//! [`SideChannelOpener`] standing in for the route resolution.

use super::*;

use async_trait::async_trait;
use serde_json::Value;
use termihub_core::connection::{FileSideChannel, FileSideChannelKind};
use termihub_core::errors::FileError;

use crate::session::graphical_browse::{
    RemoteDesktopFileBrowser, ReopenedSideChannel, SideChannelBrowsers, SideChannelOpener,
};
use crate::session::graphical_upload::{AgentHostFiles, AgentRequests, UploadCarrier};
use crate::utils::errors::TerminalError;

/// An agent host nobody talks to: the carriers here are only told apart.
struct NoAgent;

impl AgentRequests for NoAgent {
    fn request(&self, _: &str, _: &str, _: Value) -> Result<Value, FileError> {
        Err(FileError::OperationFailed("unused".to_string()))
    }
}

/// A carrier named by its agent id, so a test sees which one is registered.
fn carrier(name: &str) -> UploadCarrier {
    UploadCarrier::Agent(Arc::new(AgentHostFiles::new(
        name.to_string(),
        Arc::new(NoAgent),
    )))
}

fn route(host: &str) -> FileSideChannel {
    FileSideChannel {
        kind: FileSideChannelKind::Agent,
        host: host.to_string(),
        user: "pi".to_string(),
        same_host: true,
        linked_connection: None,
    }
}

/// Counts re-opens and answers each with the next generation's carrier
/// (`gen-1`, `gen-2`, …), or fails while `fail` is set.
#[derive(Default)]
struct FakeOpener {
    reopens: AtomicU32,
    fail: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl SideChannelOpener for FakeOpener {
    async fn reopen(
        &self,
        manager: &GraphicalSessionManager,
        session_id: &str,
    ) -> Result<ReopenedSideChannel, TerminalError> {
        // Re-opened against the session's current backend: the manager the
        // supervisor hands over still knows the session.
        assert!(manager.saved_connection_of(session_id).await.is_none());
        let n = self.reopens.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail.load(Ordering::SeqCst) {
            return Err(TerminalError::RemoteError("route down".to_string()));
        }
        Ok(ReopenedSideChannel {
            carrier: carrier(&format!("gen-{n}")),
            target: None,
            channel: route(&format!("host-{n}")),
        })
    }
}

impl FakeOpener {
    fn reopens(&self) -> u32 {
        self.reopens.load(Ordering::SeqCst)
    }
}

struct Tracked {
    h: Harness,
    browsers: SideChannelBrowsers,
    opener: Arc<FakeOpener>,
}

/// A fake session on a manager that owns `browsers`' lifecycle, with the
/// browser opened (`gen-0`) at `/home/pi/Desktop`.
async fn open_browsing(settings: Value, redials: Vec<Dial>) -> Tracked {
    let ctl = Arc::new(Control::default());
    ctl.script([Dial::Ok]);
    ctl.script(redials);
    let browsers = SideChannelBrowsers::default();
    let opener = Arc::new(FakeOpener::default());
    let mgr = GraphicalSessionManager::new(
        Arc::new(fake_registry(&ctl)),
        Arc::new(RdpTrustStore::in_memory()),
    )
    .with_jitter(|| 0.0)
    .with_side_channels(browsers.clone(), opener.clone());
    let sink = Sink::default();
    let sid = mgr
        .connect(FAKE, settings, sink.clone())
        .await
        .expect("initial connect");
    browsers.register_browse(
        &sid,
        carrier("gen-0"),
        None,
        RemoteDesktopFileBrowser {
            channel: route("host-0"),
            start_dir: "/home/pi/Desktop".to_string(),
        },
    );
    Tracked {
        h: Harness {
            mgr,
            ctl,
            sink,
            sid,
        },
        browsers,
        opener,
    }
}

fn registered(browsers: &SideChannelBrowsers, sid: &str) -> Option<String> {
    browsers
        .get(sid)
        .and_then(|c| c.agent())
        .map(|a| a.agent_id().to_string())
}

/// Drop the live stream and wait until the reconnected generation paints.
async fn reconnect(h: &Harness, dial: u32) {
    h.ctl.drop_stream();
    wait_until("re-dial", || h.ctl.dials() == dial).await;
    h.ctl.send_frame().await;
    wait_until("reconnected", || {
        last_state(&h.sink) == Some(GraphicalState::Active)
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn an_auto_reconnect_reopens_the_side_channel_and_a_disconnect_drops_it() {
    let t = open_browsing(serde_json::json!({}), vec![Dial::Ok, Dial::Ok]).await;
    let sid = t.h.sid.clone();
    assert_eq!(registered(&t.browsers, &sid).as_deref(), Some("gen-0"));

    reconnect(&t.h, 2).await;
    wait_until("re-open", || t.opener.reopens() == 1).await;
    wait_until("swapped", || {
        registered(&t.browsers, &sid).as_deref() == Some("gen-1")
    })
    .await;
    // The folder the browser opened at survives; the route line is the new one.
    let source = t.browsers.source(&sid).expect("source still open");
    assert_eq!(source.start_dir, "/home/pi/Desktop");
    assert_eq!(source.channel, route("host-1"));

    // Every reconnect re-opens on the then-current backend.
    reconnect(&t.h, 3).await;
    wait_until("second re-open", || {
        registered(&t.browsers, &sid).as_deref() == Some("gen-2")
    })
    .await;

    // The session ending drops the registration — no window has to.
    t.h.mgr.disconnect(&sid, t.h.sink.clone()).await.unwrap();
    assert!(t.browsers.get(&sid).is_none());
    assert!(t.browsers.source(&sid).is_none());
}

#[tokio::test(start_paused = true)]
async fn a_session_resting_for_good_drops_its_side_channel() {
    let t = open_browsing(serde_json::json!({ "autoReconnect": false }), Vec::new()).await;
    t.h.ctl.drop_stream();
    wait_until("disconnected", || {
        last_state(&t.h.sink) == Some(GraphicalState::Disconnected)
    })
    .await;
    wait_until("dropped", || t.browsers.get(&t.h.sid).is_none()).await;
    assert_eq!(
        t.opener.reopens(),
        0,
        "nothing re-opened without a reconnect"
    );
    t.h.mgr
        .disconnect(&t.h.sid, t.h.sink.clone())
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_reconnect_without_an_open_side_channel_opens_none() {
    let t = open_browsing(serde_json::json!({}), vec![Dial::Ok]).await;
    // The browser was never opened (or its registration is gone).
    t.browsers.remove(&t.h.sid);
    reconnect(&t.h, 2).await;
    idle().await;
    assert_eq!(t.opener.reopens(), 0);
    assert!(t.browsers.get(&t.h.sid).is_none());
    t.h.mgr
        .disconnect(&t.h.sid, t.h.sink.clone())
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_failed_reopen_keeps_the_registration() {
    let t = open_browsing(serde_json::json!({}), vec![Dial::Ok]).await;
    t.opener.fail.store(true, Ordering::SeqCst);
    reconnect(&t.h, 2).await;
    wait_until("re-open tried", || t.opener.reopens() == 1).await;
    idle().await;
    // The File Browser shows the route's error on its next listing instead.
    assert_eq!(registered(&t.browsers, &t.h.sid).as_deref(), Some("gen-0"));
    t.h.mgr
        .disconnect(&t.h.sid, t.h.sink.clone())
        .await
        .unwrap();
    assert!(t.browsers.get(&t.h.sid).is_none());
}
