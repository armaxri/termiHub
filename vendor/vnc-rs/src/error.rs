use thiserror::Error;

#[non_exhaustive]
#[derive(Debug, Error)]
pub enum VncError {
    #[error("Auth is required but no password provided")]
    NoPassword,
    #[error("No VNC encoding selected")]
    NoEncoding,
    #[error("Unknow VNC security type: {0}")]
    InvalidSecurityTyep(u8),
    #[error("Wrong password")]
    WrongPassword,
    #[error("Connect error with unknown reason")]
    ConnectError,
    #[error("Unknown pixel format")]
    WrongPixelFormat,
    #[error("Unkonw server message")]
    WrongServerMessage,
    #[error("Image data cannot be decoded correctly")]
    InvalidImageData,
    #[error("The VNC client isn't started. Or it is already closed")]
    ClientNotRunning,
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("VNC Error with message: {0}")]
    General(String),
    #[error("VeNCrypt error: {0}")]
    Vencrypt(String),
    #[error("TLS error: {0}")]
    Tls(String),
    /// The server violated the RFB protocol or exceeded a safety bound (termiHub
    /// fork, #3473). Ends the session cleanly instead of panicking.
    #[error("VNC protocol error: {0}")]
    Protocol(String),
    /// The server sent a rectangle in an encoding this client does not support
    /// (termiHub fork, #3473). Upstream silently decoded unknown encodings as
    /// Raw, desynchronising the stream.
    #[error("Unsupported VNC encoding: {0}")]
    UnsupportedEncoding(i32),
    /// An internal client task panicked (termiHub fork, #3479). The panic was
    /// caught at the task boundary; the payload is the panic message.
    #[error("Internal VNC client error: {0}")]
    Internal(String),
}

impl<T> From<tokio::sync::mpsc::error::SendError<T>> for VncError {
    fn from(_value: tokio::sync::mpsc::error::SendError<T>) -> Self {
        VncError::General("Channel closed".to_string())
    }
}
