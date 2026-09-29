//! A minimal in-process FTP server for unit tests (#3206).
//!
//! Speaks just enough of RFC 959 / RFC 3659 for the transfer executor to run a
//! real `suppaftp` client against it on loopback: login, `TYPE`, `FEAT`,
//! `SIZE`, `MDTM`, `REST`, `EPSV`/`PASV`, `RETR`, `STOR` and `QUIT`. Which of
//! `FEAT`, `REST` and `MDTM` the server supports is configurable, so a test can
//! stand up the server shapes the resume logic has to cope with — a modern
//! server advertising `REST STREAM` and `MDTM`, one without `REST`, one without
//! `MDTM`, or a legacy server that does not answer `FEAT` at all — without the
//! Docker fixture. Every `RETR`/`STOR` is logged with the offset it started
//! from, so a test can assert whether a transfer resumed or restarted.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use crate::config::FtpConfig;

/// Which optional commands the mock server supports.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MockFtpOptions {
    /// Answer `FEAT` (with the features below). `false` answers `500`, like a
    /// legacy server that predates RFC 2389.
    pub feat: bool,
    /// Accept `REST <offset>` (and advertise `REST STREAM`).
    pub rest: bool,
    /// Answer `MDTM` (and advertise it).
    pub mdtm: bool,
}

impl Default for MockFtpOptions {
    fn default() -> Self {
        Self {
            feat: true,
            rest: true,
            mdtm: true,
        }
    }
}

/// One stored file: its bytes and its `MDTM` timestamp (`YYYYMMDDHHMMSS`).
#[derive(Debug, Clone)]
struct MockFile {
    data: Vec<u8>,
    mtime: String,
}

/// A data transfer the server ran: the command, its path, and the byte offset
/// it started from (the accepted `REST`, or `0`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MockTransfer {
    pub command: &'static str,
    pub path: String,
    pub offset: u64,
}

#[derive(Default)]
struct State {
    files: HashMap<String, MockFile>,
    transfers: Vec<MockTransfer>,
    rest_commands: usize,
}

/// A running mock server. Dropping it leaves the accept loop running until the
/// test's runtime shuts down, which is when the test ends.
pub(crate) struct MockFtpServer {
    port: u16,
    state: Arc<Mutex<State>>,
}

impl MockFtpServer {
    /// Bind a loopback port and start serving.
    pub(crate) async fn start(options: MockFtpOptions) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock");
        let port = listener.local_addr().expect("local addr").port();
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        tokio::spawn(async move {
            while let Ok((control, _)) = listener.accept().await {
                let state = shared.clone();
                tokio::spawn(async move {
                    let _ = serve(control, options, state).await;
                });
            }
        });
        Self { port, state }
    }

    /// A plain-FTP config pointing at this server.
    pub(crate) fn config(&self) -> FtpConfig {
        FtpConfig {
            host: "127.0.0.1".to_string(),
            port: self.port,
            username: "user".to_string(),
            password: Some("pass".to_string()),
            ..FtpConfig::default()
        }
    }

    /// Store `data` at `path` with the `MDTM` timestamp `mtime`.
    pub(crate) fn put(&self, path: &str, data: &[u8], mtime: &str) {
        self.lock().files.insert(
            path.to_string(),
            MockFile {
                data: data.to_vec(),
                mtime: mtime.to_string(),
            },
        );
    }

    /// The bytes stored at `path`, if any.
    pub(crate) fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.lock().files.get(path).map(|f| f.data.clone())
    }

    /// Every `RETR`/`STOR` the server ran, in order.
    pub(crate) fn transfers(&self) -> Vec<MockTransfer> {
        self.lock().transfers.clone()
    }

    /// How many `REST` commands the server received (accepted or not).
    pub(crate) fn rest_commands(&self) -> usize {
        self.lock().rest_commands
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("mock state")
    }
}

async fn reply(w: &mut tokio::net::tcp::OwnedWriteHalf, line: &str) -> std::io::Result<()> {
    w.write_all(format!("{line}\r\n").as_bytes()).await
}

/// Serve one control connection until `QUIT` or EOF.
async fn serve(
    control: TcpStream,
    options: MockFtpOptions,
    state: Arc<Mutex<State>>,
) -> std::io::Result<()> {
    let (read, mut w) = control.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut data_listener: Option<TcpListener> = None;
    let mut rest: u64 = 0;
    reply(&mut w, "220 mock FTP ready").await?;
    while let Some(line) = lines.next_line().await? {
        let (cmd, arg) = match line.split_once(' ') {
            Some((c, a)) => (c.to_ascii_uppercase(), a.to_string()),
            None => (line.trim().to_ascii_uppercase(), String::new()),
        };
        match cmd.as_str() {
            "USER" => reply(&mut w, "331 password please").await?,
            "PASS" => reply(&mut w, "230 logged in").await?,
            "TYPE" => reply(&mut w, "200 type set").await?,
            "NOOP" => reply(&mut w, "200 ok").await?,
            "CWD" => reply(&mut w, "250 ok").await?,
            "FEAT" if options.feat => {
                let mut out = String::from("211-Features:\r\n SIZE\r\n");
                if options.mdtm {
                    out.push_str(" MDTM\r\n");
                }
                if options.rest {
                    out.push_str(" REST STREAM\r\n");
                }
                out.push_str("211 End\r\n");
                w.write_all(out.as_bytes()).await?;
            }
            "SIZE" => {
                let size = state
                    .lock()
                    .expect("mock state")
                    .files
                    .get(&arg)
                    .map(|f| f.data.len());
                match size {
                    Some(size) => reply(&mut w, &format!("213 {size}")).await?,
                    None => reply(&mut w, "550 no such file").await?,
                }
            }
            "MDTM" if options.mdtm => {
                let mtime = state
                    .lock()
                    .expect("mock state")
                    .files
                    .get(&arg)
                    .map(|f| f.mtime.clone());
                match mtime {
                    Some(mtime) => reply(&mut w, &format!("213 {mtime}")).await?,
                    None => reply(&mut w, "550 no such file").await?,
                }
            }
            "REST" => {
                state.lock().expect("mock state").rest_commands += 1;
                match arg.trim().parse::<u64>() {
                    Ok(offset) if options.rest => {
                        rest = offset;
                        reply(&mut w, &format!("350 restarting at {offset}")).await?;
                    }
                    _ => reply(&mut w, "502 REST not implemented").await?,
                }
            }
            "EPSV" => {
                let listener = TcpListener::bind("127.0.0.1:0").await?;
                let port = listener.local_addr()?.port();
                data_listener = Some(listener);
                reply(
                    &mut w,
                    &format!("229 Entering Extended Passive Mode (|||{port}|)"),
                )
                .await?;
            }
            "PASV" => {
                let listener = TcpListener::bind("127.0.0.1:0").await?;
                let port = listener.local_addr()?.port();
                data_listener = Some(listener);
                reply(
                    &mut w,
                    &format!(
                        "227 Entering Passive Mode (127,0,0,1,{},{})",
                        port / 256,
                        port % 256
                    ),
                )
                .await?;
            }
            "RETR" => {
                let offset = std::mem::take(&mut rest);
                let data = {
                    let mut st = state.lock().expect("mock state");
                    let data = st.files.get(&arg).map(|f| f.data.clone());
                    if data.is_some() {
                        st.transfers.push(MockTransfer {
                            command: "RETR",
                            path: arg.clone(),
                            offset,
                        });
                    }
                    data
                };
                let (Some(data), Some(listener)) = (data, data_listener.take()) else {
                    reply(&mut w, "550 no such file").await?;
                    continue;
                };
                reply(&mut w, "150 opening data connection").await?;
                let (mut conn, _) = listener.accept().await?;
                let start = usize::try_from(offset).unwrap_or(usize::MAX).min(data.len());
                let _ = conn.write_all(&data[start..]).await;
                let _ = conn.shutdown().await;
                drop(conn);
                reply(&mut w, "226 transfer complete").await?;
            }
            "STOR" => {
                let offset = std::mem::take(&mut rest);
                let Some(listener) = data_listener.take() else {
                    reply(&mut w, "425 no data connection").await?;
                    continue;
                };
                reply(&mut w, "150 opening data connection").await?;
                let (mut conn, _) = listener.accept().await?;
                let mut received = Vec::new();
                let _ = conn.read_to_end(&mut received).await;
                {
                    let mut st = state.lock().expect("mock state");
                    st.transfers.push(MockTransfer {
                        command: "STOR",
                        path: arg.clone(),
                        offset,
                    });
                    let file = st.files.entry(arg.clone()).or_insert_with(|| MockFile {
                        data: Vec::new(),
                        mtime: "20240101000000".to_string(),
                    });
                    let keep = usize::try_from(offset)
                        .unwrap_or(usize::MAX)
                        .min(file.data.len());
                    file.data.truncate(keep);
                    file.data.extend_from_slice(&received);
                }
                reply(&mut w, "226 transfer complete").await?;
            }
            "QUIT" => {
                reply(&mut w, "221 bye").await?;
                break;
            }
            _ => reply(&mut w, "500 unknown command").await?,
        }
    }
    Ok(())
}
