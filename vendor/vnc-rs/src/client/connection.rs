use futures::TryStreamExt;
use tokio_stream::wrappers::ReceiverStream;

use std::{future::Future, sync::Arc, vec};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{
        mpsc::{channel, error::TryRecvError, Receiver, Sender},
        oneshot, Mutex,
    },
};
use tokio_util::compat::*;
use tracing::*;

use crate::{codec, PixelFormat, Rect, VncEncoding, VncError, VncEvent, X11Event};
const CHANNEL_SIZE: usize = 4096;

#[cfg(not(target_arch = "wasm32"))]
use tokio::spawn;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_futures::spawn_local as spawn;

use super::messages::{ClientMsg, ServerMsg};

struct ImageRect {
    rect: Rect,
    encoding: VncEncoding,
}

impl TryFrom<[u8; 12]> for ImageRect {
    type Error = VncError;

    fn try_from(buf: [u8; 12]) -> Result<Self, VncError> {
        let encoding = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
        Ok(Self {
            rect: Rect {
                x: u16::from_be_bytes([buf[0], buf[1]]),
                y: u16::from_be_bytes([buf[2], buf[3]]),
                width: u16::from_be_bytes([buf[4], buf[5]]),
                height: u16::from_be_bytes([buf[6], buf[7]]),
            },
            // termiHub fork (#3473): an encoding we never negotiated ends the
            // session with a typed error instead of being decoded as Raw.
            encoding: VncEncoding::from_wire(encoding)
                .ok_or(VncError::UnsupportedEncoding(encoding as i32))?,
        })
    }
}

impl ImageRect {
    async fn read<S>(reader: &mut S) -> Result<Self, VncError>
    where
        S: AsyncRead + Unpin,
    {
        let mut rect_buf = [0_u8; 12];
        reader.read_exact(&mut rect_buf).await?;
        rect_buf.try_into()
    }
}

/// Largest desktop name accepted in `ServerInit` (termiHub fork, #3473). The
/// length is a server-chosen `u32`; upstream allocated it verbatim (up to 4 GiB).
/// Lowered from 64 KiB to upstream 0.6.0's 4 KiB bound (#3499).
const MAX_DESKTOP_NAME_BYTES: u32 = 4096;

/// Run one of the client's internal tasks with a panic boundary (termiHub fork,
/// #3473). A panic in the decoder must never take the host down silently: it is
/// caught here, logged, and reported to the consumer as [`VncEvent::Error`] so
/// the session ends cleanly like any other protocol error.
async fn run_guarded<Fut>(task: &'static str, fut: Fut, report: Option<Sender<VncEvent>>)
where
    Fut: Future<Output = ()>,
{
    use futures::FutureExt;
    if let Err(panic) = std::panic::AssertUnwindSafe(fut).catch_unwind().await {
        let detail = panic
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        error!("VNC {task} task panicked: {detail}");
        if let Some(tx) = report {
            let _ = tx
                .send(VncEvent::Error(Arc::new(VncError::Internal(format!(
                    "{task} task: {detail}"
                )))))
                .await;
        }
    }
}

struct VncInner {
    name: String,
    screen: (u16, u16),
    input_ch: Sender<ClientMsg>,
    output_ch: Receiver<VncEvent>,
    decoding_stop: Option<oneshot::Sender<()>>,
    net_conn_stop: Option<oneshot::Sender<()>>,
    closed: bool,
}

/// The instance of a connected vnc client
///
impl VncInner {
    async fn new<S>(
        mut stream: S,
        shared: bool,
        mut pixel_format: Option<PixelFormat>,
        encodings: Vec<VncEncoding>,
    ) -> Result<Self, VncError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (conn_ch_tx, conn_ch_rx) = channel(CHANNEL_SIZE);
        let (input_ch_tx, input_ch_rx) = channel(CHANNEL_SIZE);
        let (output_ch_tx, output_ch_rx) = channel(CHANNEL_SIZE);
        let (decoding_stop_tx, decoding_stop_rx) = oneshot::channel();
        let (net_conn_stop_tx, net_conn_stop_rx) = oneshot::channel();

        trace!("client init msg");
        send_client_init(&mut stream, shared).await?;

        trace!("server init msg");
        let (name, (width, height)) =
            read_server_init(&mut stream, &mut pixel_format, &|e| async {
                output_ch_tx.send(e).await?;
                Ok(())
            })
            .await?;

        trace!("client encodings: {:?}", encodings);
        send_client_encoding(&mut stream, encodings.clone()).await?;

        trace!("Require the first frame");
        input_ch_tx
            .send(ClientMsg::FramebufferUpdateRequest(
                Rect {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
                0,
            ))
            .await?;

        // start the decoding thread
        let panic_report = output_ch_tx.clone();
        spawn(run_guarded(
            "decoder",
            async move {
                trace!("Decoding thread starts");
                let mut conn_ch_rx = {
                    let conn_ch_rx = ReceiverStream::new(conn_ch_rx).into_async_read();
                    FuturesAsyncReadCompatExt::compat(conn_ch_rx)
                };

                let output_func = |e| async {
                    output_ch_tx.send(e).await?;
                    Ok(())
                };

                // `read_server_init` always fills `pixel_format` (with the server's
                // format when the caller did not choose one).
                let pf = pixel_format.unwrap_or_default();
                let pf = &pf;
                let mut decoding_stop_rx = decoding_stop_rx;
                let result = asycn_vnc_read_loop(
                    &mut conn_ch_rx,
                    pf,
                    &output_func,
                    &mut decoding_stop_rx,
                    &encodings,
                    (width, height),
                )
                .await;
                // termiHub fork (#3499, upstream 6acf3da): release the network
                // bridge before waiting for output capacity, so the connection
                // task is never kept alive by a decoder parked on a full queue.
                drop(conn_ch_rx);
                if let Err(e) = result {
                    report_decoder_error(e, &output_ch_tx, &mut decoding_stop_rx).await;
                }
                trace!("Decoding thread stops");
            },
            Some(panic_report),
        ));

        // start the traffic process thread
        spawn(run_guarded(
            "connection",
            async move {
                trace!("Net Connection thread starts");
                let _ = async_connection_process_loop(
                    stream,
                    input_ch_rx,
                    conn_ch_tx,
                    net_conn_stop_rx,
                )
                .await;
                trace!("Net Connection thread stops");
            },
            None,
        ));

        info!("VNC Client {name} starts");
        Ok(Self {
            name,
            screen: (width, height),
            input_ch: input_ch_tx,
            output_ch: output_ch_rx,
            decoding_stop: Some(decoding_stop_tx),
            net_conn_stop: Some(net_conn_stop_tx),
            closed: false,
        })
    }

    /// Translate a frontend event into the client message to send.
    fn input_message(&self, event: X11Event) -> Result<ClientMsg, VncError> {
        if self.closed {
            Err(VncError::ClientNotRunning)
        } else {
            let msg = match event {
                X11Event::Refresh => ClientMsg::FramebufferUpdateRequest(
                    Rect {
                        x: 0,
                        y: 0,
                        width: self.screen.0,
                        height: self.screen.1,
                    },
                    1,
                ),
                X11Event::FullRefresh => ClientMsg::FramebufferUpdateRequest(
                    Rect {
                        x: 0,
                        y: 0,
                        width: self.screen.0,
                        height: self.screen.1,
                    },
                    0, // non-incremental: server sends entire framebuffer
                ),
                X11Event::KeyEvent(key) => ClientMsg::KeyEvent(key.keycode, key.down),
                X11Event::PointerEvent(mouse) => {
                    ClientMsg::PointerEvent(mouse.position_x, mouse.position_y, mouse.bottons)
                }
                X11Event::CopyText(text) => ClientMsg::ClientCutText(text),
            };
            Ok(msg)
        }
    }

    async fn recv_event(&mut self) -> Result<VncEvent, VncError> {
        if self.closed {
            Err(VncError::ClientNotRunning)
        } else {
            match self.output_ch.recv().await {
                Some(e) => Ok(e),
                None => {
                    self.closed = true;
                    Err(VncError::ClientNotRunning)
                }
            }
        }
    }

    async fn poll_event(&mut self) -> Result<Option<VncEvent>, VncError> {
        if self.closed {
            Err(VncError::ClientNotRunning)
        } else {
            match self.output_ch.try_recv() {
                Err(TryRecvError::Disconnected) => {
                    self.closed = true;
                    Err(VncError::ClientNotRunning)
                }
                Err(TryRecvError::Empty) => Ok(None),
                Ok(e) => Ok(Some(e)),
            }
            // Ok(self.output_ch.recv().await)
        }
    }

    /// Stop the VNC engine and release resources
    ///
    fn close(&mut self) -> Result<(), VncError> {
        if self.net_conn_stop.is_some() {
            let net_conn_stop: oneshot::Sender<()> = self.net_conn_stop.take().unwrap();
            let _ = net_conn_stop.send(());
        }
        if self.decoding_stop.is_some() {
            let decoding_stop = self.decoding_stop.take().unwrap();
            let _ = decoding_stop.send(());
        }
        self.closed = true;
        Ok(())
    }
}

impl Drop for VncInner {
    fn drop(&mut self) {
        info!("VNC Client {} stops", self.name);
        let _ = self.close();
    }
}

pub struct VncClient {
    inner: Arc<Mutex<VncInner>>,
}

impl VncClient {
    pub(super) async fn new<S>(
        stream: S,
        shared: bool,
        pixel_format: Option<PixelFormat>,
        encodings: Vec<VncEncoding>,
    ) -> Result<Self, VncError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        Ok(Self {
            inner: Arc::new(Mutex::new(
                VncInner::new(stream, shared, pixel_format, encodings).await?,
            )),
        })
    }

    /// Input a `X11Event` from the frontend
    ///
    pub async fn input(&self, event: X11Event) -> Result<(), VncError> {
        // termiHub fork (#3499, upstream dea233d): never hold the client mutex
        // while waiting for input-queue capacity. Upstream awaited `send` under
        // the lock, so a server that stops reading (full socket -> full queue)
        // wedged `poll_event`, `recv_event` *and* `close` on the same mutex.
        let sender = {
            let inner = self.inner.lock().await;
            if inner.closed {
                return Err(VncError::ClientNotRunning);
            }
            inner.input_ch.clone()
        };
        let permit = sender.reserve().await?;
        let msg = self.inner.lock().await.input_message(event)?;
        permit.send(msg);
        Ok(())
    }

    /// Receive a `VncEvent` from the engine
    /// This function will block until a `VncEvent` is received
    ///
    pub async fn recv_event(&self) -> Result<VncEvent, VncError> {
        self.inner.lock().await.recv_event().await
    }

    /// polling `VncEvent` from the engine and give it to the client
    ///
    pub async fn poll_event(&self) -> Result<Option<VncEvent>, VncError> {
        self.inner.lock().await.poll_event().await
    }

    /// Stop the VNC engine and release resources
    ///
    pub async fn close(&self) -> Result<(), VncError> {
        self.inner.lock().await.close()
    }
}

impl Clone for VncClient {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

async fn send_client_init<S>(stream: &mut S, shared: bool) -> Result<(), VncError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    trace!("Send shared flag: {}", shared);
    stream.write_u8(shared as u8).await?;
    Ok(())
}

async fn read_server_init<S, F, Fut>(
    stream: &mut S,
    pf: &mut Option<PixelFormat>,
    output_func: &F,
) -> Result<(String, (u16, u16)), VncError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: Fn(VncEvent) -> Fut,
    Fut: Future<Output = Result<(), VncError>>,
{
    // +--------------+--------------+------------------------------+
    // | No. of bytes | Type [Value] | Description                  |
    // +--------------+--------------+------------------------------+
    // | 2            | U16          | framebuffer-width in pixels  |
    // | 2            | U16          | framebuffer-height in pixels |
    // | 16           | PIXEL_FORMAT | server-pixel-format          |
    // | 4            | U32          | name-length                  |
    // | name-length  | U8 array     | name-string                  |
    // +--------------+--------------+------------------------------+

    let screen_width = stream.read_u16().await?;
    let screen_height = stream.read_u16().await?;
    // termiHub fork (#3499, upstream 623b894): bound the initial framebuffer.
    codec::validate_screen(screen_width, screen_height)?;
    let mut send_our_pf = false;

    output_func(VncEvent::SetResolution(
        (screen_width, screen_height).into(),
    ))
    .await?;

    let pixel_format = PixelFormat::read(stream).await?;
    if pf.is_none() {
        // termiHub fork (#3499, upstream 1c07e2c): the server's format is only
        // validated when the client will actually decode with it; a caller-set
        // format was validated by `VncConnector::build` and replaces it.
        pixel_format.validate()?;
        output_func(VncEvent::SetPixelFormat(pixel_format)).await?;
        let _ = pf.insert(pixel_format);
    } else {
        send_our_pf = true;
    }

    let name_len = stream.read_u32().await?;
    if name_len > MAX_DESKTOP_NAME_BYTES {
        return Err(VncError::Protocol(format!(
            "server desktop name of {name_len} bytes exceeds the {MAX_DESKTOP_NAME_BYTES}-byte limit"
        )));
    }
    let mut name_buf = vec![0_u8; name_len as usize];
    stream.read_exact(&mut name_buf).await?;
    let name = String::from_utf8_lossy(&name_buf).into_owned();

    if send_our_pf {
        trace!("Send customized pixel format {:#?}", pf);
        if let Some(pf) = pf.as_ref() {
            ClientMsg::SetPixelFormat(*pf).write(stream).await?;
        }
    }
    Ok((name, (screen_width, screen_height)))
}

async fn send_client_encoding<S>(
    stream: &mut S,
    encodings: Vec<VncEncoding>,
) -> Result<(), VncError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    ClientMsg::SetEncodings(encodings).write(stream).await?;
    Ok(())
}

/// Report a decoder failure to the consumer (termiHub fork, #3499 — adapted
/// from upstream 6acf3da). A normal disconnect (bridge EOF) is silent. Waiting
/// for output capacity races the stop signal, so `close()` never leaves the
/// decoder task parked on a consumer that stopped draining.
async fn report_decoder_error(
    error: VncError,
    output: &Sender<VncEvent>,
    stop: &mut oneshot::Receiver<()>,
) {
    if let VncError::IoError(e) = &error {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            // The network bridge closes with EOF on a normal disconnection.
            return;
        }
    }
    error!("Error occurs during the decoding {:?}", error);
    tokio::select! {
        biased;
        _ = stop => {}
        _ = output.send(VncEvent::Error(Arc::new(error))) => {}
    }
}

/// The decoding loop, cancelled as a whole by `stop_ch` (termiHub fork, #3499,
/// upstream dea233d): upstream only checked the stop signal between messages,
/// so a decoder blocked mid-message (or on a full output queue) ignored
/// `close()`.
///
/// `encodings` is the list the client sent in `SetEncodings`; `screen` is the
/// framebuffer size from `ServerInit`, tracked through `DesktopSize` updates.
pub(super) async fn asycn_vnc_read_loop<S, F, Fut>(
    stream: &mut S,
    pf: &PixelFormat,
    output_func: &F,
    stop_ch: &mut oneshot::Receiver<()>,
    encodings: &[VncEncoding],
    screen: (u16, u16),
) -> Result<(), VncError>
where
    S: AsyncRead + Unpin,
    F: Fn(VncEvent) -> Fut,
    Fut: Future<Output = Result<(), VncError>>,
{
    tokio::select! {
        biased;
        _ = stop_ch => Ok(()),
        result = read_vnc_messages(stream, pf, output_func, encodings, screen) => result,
    }
}

async fn read_vnc_messages<S, F, Fut>(
    stream: &mut S,
    pf: &PixelFormat,
    output_func: &F,
    encodings: &[VncEncoding],
    mut screen: (u16, u16),
) -> Result<(), VncError>
where
    S: AsyncRead + Unpin,
    F: Fn(VncEvent) -> Fut,
    Fut: Future<Output = Result<(), VncError>>,
{
    let mut raw_decoder = codec::RawDecoder::new();
    let mut zrle_decoder = codec::ZrleDecoder::new();
    let mut tight_decoder = codec::TightDecoder::new();
    let mut trle_decoder = codec::TrleDecoder::new();
    let mut cursor = codec::CursorDecoder::new();

    // main decoding loop
    loop {
        let server_msg = ServerMsg::read(stream).await?;
        trace!("Server message got: {:?}", server_msg);
        match server_msg {
            ServerMsg::FramebufferUpdate(rect_num) => {
                for _ in 0..rect_num {
                    let rect = ImageRect::read(stream).await?;

                    // termiHub fork (#3499, upstream 623b894): the server may only
                    // use an encoding the client asked for (Raw is always allowed).
                    if rect.encoding != VncEncoding::Raw && !encodings.contains(&rect.encoding) {
                        return Err(VncError::Protocol(format!(
                            "server used encoding {:?} that the client did not negotiate",
                            rect.encoding
                        )));
                    }

                    // termiHub fork (#3473): bound the server-chosen geometry of
                    // every pixel-carrying rectangle before a decoder allocates
                    // for it. Pseudo-encodings reuse the fields for other meanings
                    // (cursor hotspot, desktop size) and are bounded by their own
                    // handlers.
                    if matches!(
                        rect.encoding,
                        VncEncoding::Raw
                            | VncEncoding::CopyRect
                            | VncEncoding::Tight
                            | VncEncoding::Trle
                            | VncEncoding::Zrle
                    ) {
                        codec::validate_image_rect(&rect.rect)?;
                        // termiHub fork (#3499, upstream 623b894): and it must lie
                        // inside the current framebuffer.
                        codec::validate_rect_on_screen(&rect.rect, screen)?;
                    }

                    match rect.encoding {
                        VncEncoding::Raw => {
                            raw_decoder
                                .decode(pf, &rect.rect, stream, output_func)
                                .await?;
                        }
                        VncEncoding::CopyRect => {
                            let source_x = stream.read_u16().await?;
                            let source_y = stream.read_u16().await?;
                            let mut src_rect = rect.rect;
                            src_rect.x = source_x;
                            src_rect.y = source_y;
                            codec::validate_image_rect(&src_rect)?;
                            codec::validate_rect_on_screen(&src_rect, screen)?;
                            output_func(VncEvent::Copy(rect.rect, src_rect)).await?;
                        }
                        VncEncoding::Tight => {
                            tight_decoder
                                .decode(pf, &rect.rect, stream, output_func)
                                .await?;
                        }
                        VncEncoding::Trle => {
                            trle_decoder
                                .decode(pf, &rect.rect, stream, output_func)
                                .await?;
                        }
                        VncEncoding::Zrle => {
                            zrle_decoder
                                .decode(pf, &rect.rect, stream, output_func)
                                .await?;
                        }
                        VncEncoding::CursorPseudo => {
                            cursor.decode(pf, &rect.rect, stream, output_func).await?;
                        }
                        VncEncoding::DesktopSizePseudo => {
                            // termiHub fork (#3499, upstream 623b894): bound the new
                            // size and track it for the on-screen checks above.
                            codec::validate_screen(rect.rect.width, rect.rect.height)?;
                            screen = (rect.rect.width, rect.rect.height);
                            output_func(VncEvent::SetResolution(
                                (rect.rect.width, rect.rect.height).into(),
                            ))
                            .await?;
                        }
                        VncEncoding::LastRectPseudo => {
                            break;
                        }
                    }
                }
            }
            ServerMsg::SetColorMapEntries(first, count) => {
                trace!(
                    first,
                    count,
                    "ignored SetColorMapEntries (true-colour client)"
                );
            }
            ServerMsg::Bell => {
                output_func(VncEvent::Bell).await?;
            }
            ServerMsg::ServerCutText(text) => {
                output_func(VncEvent::Text(text)).await?;
            }
            ServerMsg::ServerCutTextDropped(len) => {
                warn!(
                    len,
                    "discarded an oversize ServerCutText (termiHub PROD-021 cap)"
                );
            }
        }
    }
}

async fn async_connection_process_loop<S>(
    mut stream: S,
    mut input_ch: Receiver<ClientMsg>,
    conn_ch: Sender<std::io::Result<Vec<u8>>>,
    mut stop_ch: oneshot::Receiver<()>,
) -> Result<(), VncError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut buffer = [0; 65535];
    let mut pending = 0;

    // termiHub fork (#3499, upstream dea233d): upstream retried a bridge
    // `try_send` only when some *other* select arm fired, so once the decoder
    // queue filled the task could sleep forever with data pending (reads are
    // disabled while `pending > 0`). Reserving capacity inside the select wakes
    // it the moment the decoder frees a slot. Socket writes also race the stop
    // signal, so `close()` cancels a write blocked on a server that stopped
    // reading.
    loop {
        tokio::select! {
            _ = &mut stop_ch => break,
            _ = conn_ch.closed() => break,
            permit = conn_ch.reserve(), if pending > 0 => {
                match permit {
                    Ok(permit) => {
                        permit.send(Ok(buffer[..pending].to_vec()));
                        pending = 0;
                    }
                    Err(_) => break,
                }
            }
            result = stream.read(&mut buffer), if pending == 0 => {
                match result {
                    // According to the tokio's Doc
                    // https://docs.rs/tokio/latest/tokio/io/trait.AsyncRead.html
                    // if nread == 0, then EOF is reached
                    Ok(0) => {
                        trace!("Net Connection EOF detected");
                        break;
                    }
                    Ok(nread) => pending = nread,
                    Err(e) => {
                        error!("{}", e.to_string());
                        break;
                    }
                }
            }
            msg = input_ch.recv() => {
                let Some(msg) = msg else { break };
                tokio::select! {
                    biased;
                    _ = &mut stop_ch => break,
                    result = msg.write(&mut stream) => result?,
                }
            }
        }
    }

    // Dropping `conn_ch` ends the bridge, which the decoder reads as EOF.
    // Upstream `send().await`ed an explicit EOF here, which blocked shutdown for
    // as long as the decoder's queue stayed full.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_panicking_task_reports_an_error_event_instead_of_dying_silently() {
        let (tx, mut rx) = channel(4);
        run_guarded(
            "decoder",
            async {
                panic!("boom");
            },
            Some(tx),
        )
        .await;
        match rx.recv().await {
            Some(VncEvent::Error(err)) => match err.as_ref() {
                VncError::Internal(msg) => assert!(msg.contains("boom"), "{msg}"),
                other => panic!("expected an internal error, got {other:?}"),
            },
            other => panic!("expected an error event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_well_behaved_task_reports_nothing() {
        let (tx, mut rx) = channel(4);
        run_guarded("decoder", async {}, Some(tx)).await;
        assert!(rx.recv().await.is_none());
    }

    /// termiHub fork (#3499, upstream dea233d): once the decoder bridge is
    /// full, the connection task must resume as soon as the decoder frees a
    /// slot. Upstream parked with data pending and no arm that could wake it.
    #[tokio::test]
    async fn network_bridge_resumes_when_the_decoder_frees_a_slot() {
        let (mut server, client) = tokio::io::duplex(16);
        let (_input_tx, input_rx) = channel(1);
        let (conn_tx, mut conn_rx) = channel(1);
        let (_stop_tx, stop_rx) = oneshot::channel();
        let task = spawn(async_connection_process_loop(
            client, input_rx, conn_tx, stop_rx,
        ));

        let total = 16 * 64;
        let writer = spawn(async move {
            for i in 0..64u8 {
                server.write_all(&[i; 16]).await.unwrap();
            }
            server
        });
        // Drain slowly: every chunk must arrive even though the bridge holds
        // only one message and each read leaves the task with data pending.
        let mut received = Vec::new();
        while received.len() < total {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(5), conn_rx.recv())
                .await
                .expect("the connection task stalled with data pending")
                .unwrap()
                .unwrap();
            received.extend(chunk);
        }
        let expected: Vec<u8> = (0..64u8).flat_map(|i| [i; 16]).collect();
        assert_eq!(received, expected);
        drop(writer.await.unwrap()); // server EOF
        assert!(conn_rx.recv().await.is_none(), "EOF closes the bridge");
        task.await.unwrap().unwrap();
    }

    /// Dropping the bridge on exit must not wait for decoder capacity
    /// (upstream `send().await`ed an explicit EOF into a possibly full queue).
    #[tokio::test]
    async fn stopping_does_not_block_on_a_full_bridge() {
        let (mut server, client) = tokio::io::duplex(64);
        let (_input_tx, input_rx) = channel(1);
        let (conn_tx, conn_rx) = channel(1);
        let (stop_tx, stop_rx) = oneshot::channel();
        let task = spawn(async_connection_process_loop(
            client, input_rx, conn_tx, stop_rx,
        ));
        server.write_all(&[1; 64]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        stop_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("stop must not wait on a full bridge")
            .unwrap()
            .unwrap();
        drop(conn_rx);
    }

    #[tokio::test]
    async fn oversize_desktop_name_is_rejected_before_allocating() {
        // ServerInit: 1x1, a pixel format, then a 4 GiB name length.
        let mut server_init = vec![0, 1, 0, 1];
        server_init.extend(<PixelFormat as Into<Vec<u8>>>::into(PixelFormat::rgba()));
        server_init.extend_from_slice(&u32::MAX.to_be_bytes());
        let (mut client, mut server) = tokio::io::duplex(1024);
        server.write_all(&server_init).await.unwrap();
        let mut pf = Some(PixelFormat::rgba());
        let result = read_server_init(&mut client, &mut pf, &|_e| async { Ok(()) }).await;
        assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
    }
}
