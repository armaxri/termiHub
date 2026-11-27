//! Which side of a relayed connection ended first, and when (#6139).
//!
//! An SSH server can confirm a `direct-tcpip` channel before it connects to
//! the target, and end the channel when the target refuses: Win32-OpenSSH
//! does. The forwarder then sees an open channel that ends at once without a
//! byte, where an OpenSSH server on POSIX refuses the open. [`EndWatch`]
//! records the end of each side so the relay can count that as refused.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// How soon after its open a channel that the server ends without a byte
/// still counts as refused. A refused connect on Windows takes about 2 s.
pub(crate) const REFUSED_WITHIN: Duration = Duration::from_secs(5);

/// When a stream's reading side first reached its end.
pub(crate) type EndedAt = Arc<OnceLock<Instant>>;

/// A stream that records when its reading side first ends.
pub(crate) struct EndWatch<S> {
    inner: S,
    ended: EndedAt,
}

impl<S> EndWatch<S> {
    /// Watch `inner`; the returned handle holds the end once it is read.
    pub(crate) fn new(inner: S) -> (Self, EndedAt) {
        let ended = EndedAt::default();
        (
            Self {
                inner,
                ended: Arc::clone(&ended),
            },
            ended,
        )
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for EndWatch<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(polled, Poll::Ready(Ok(()))) && buf.filled().len() == before {
            let _ = self.ended.set(Instant::now());
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for EndWatch<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Whether a relayed connection was refused by its target: the server ended
/// the channel, before the client left, within [`REFUSED_WITHIN`] of the
/// open, and the target sent nothing.
pub(crate) fn refused_by_target(
    opened: Instant,
    channel_ended: Option<Instant>,
    client_ended: Option<Instant>,
    received: u64,
) -> bool {
    let Some(channel_ended) = channel_ended else {
        return false;
    };
    received == 0
        && client_ended.is_none_or(|client| channel_ended <= client)
        && channel_ended.duration_since(opened) <= REFUSED_WITHIN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_quick_wordless_end_by_the_server_is_a_refusal() {
        let opened = Instant::now();
        let soon = opened + Duration::from_millis(2100);
        let late = opened + REFUSED_WITHIN + Duration::from_secs(1);
        assert!(refused_by_target(opened, Some(soon), None, 0));
        assert!(refused_by_target(opened, Some(soon), Some(late), 0));
        assert!(
            !refused_by_target(opened, Some(soon), None, 1),
            "it answered"
        );
        assert!(!refused_by_target(opened, Some(late), None, 0), "too late");
        assert!(
            !refused_by_target(opened, None, Some(soon), 0),
            "still open"
        );
        let first = opened + Duration::from_millis(10);
        assert!(
            !refused_by_target(opened, Some(soon), Some(first), 0),
            "the client left first"
        );
    }
}
