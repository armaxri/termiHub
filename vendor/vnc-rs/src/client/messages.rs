use crate::{PixelFormat, Rect, VncEncoding, VncError};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Largest `ServerCutText` payload accepted from the server (termiHub fork,
/// PROD-021). The length is server-chosen and untrusted: upstream allocated it
/// verbatim, so a hostile server could announce 4 GiB. A larger payload is read
/// and discarded in bounded chunks (keeping the stream in sync) and surfaced as
/// [`ServerMsg::ServerCutTextDropped`].
pub(crate) const MAX_SERVER_CUT_TEXT_BYTES: u32 = 16 * 1024 * 1024;

/// Decode `ServerCutText` bytes (termiHub fork, PROD-021). RFB specifies
/// ISO-8859-1 (Latin-1), but many servers send UTF-8 in practice; a payload that
/// is valid UTF-8 is taken as UTF-8, anything else is decoded as Latin-1 (every
/// byte maps to the code point of the same value) so accented text survives
/// instead of turning into U+FFFD replacement characters.
pub(crate) fn decode_cut_text(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => e.into_bytes().into_iter().map(char::from).collect(),
    }
}

/// Encode text for `ClientCutText` (termiHub fork, PROD-021): Latin-1 as RFB
/// specifies when every character is representable (U+0000..=U+00FF), otherwise
/// UTF-8 — the standard clipboard has no way to carry those characters, and
/// UTF-8 is what servers that deviate from the spec expect.
pub(crate) fn encode_cut_text(text: &str) -> Vec<u8> {
    if text.chars().all(|c| u32::from(c) <= 0xFF) {
        text.chars().map(|c| u32::from(c) as u8).collect()
    } else {
        text.as_bytes().to_vec()
    }
}

#[derive(Debug)]
pub(super) enum ClientMsg {
    SetPixelFormat(PixelFormat),
    SetEncodings(Vec<VncEncoding>),
    FramebufferUpdateRequest(Rect, u8),
    KeyEvent(u32, bool),
    PointerEvent(u16, u16, u8),
    ClientCutText(String),
}

impl ClientMsg {
    pub(super) async fn write<S>(self, writer: &mut S) -> Result<(), VncError>
    where
        S: AsyncWrite + Unpin,
    {
        match self {
            ClientMsg::SetPixelFormat(pf) => {
                // +--------------+--------------+--------------+
                // | No. of bytes | Type [Value] | Description  |
                // +--------------+--------------+--------------+
                // | 1            | U8 [0]       | message-type |
                // | 3            |              | padding      |
                // | 16           | PIXEL_FORMAT | pixel-format |
                // +--------------+--------------+--------------+
                let mut payload = vec![0_u8, 0, 0, 0];
                payload.extend(<PixelFormat as Into<Vec<u8>>>::into(pf));
                writer.write_all(&payload).await?;
                Ok(())
            }
            ClientMsg::SetEncodings(encodings) => {
                //  +--------------+--------------+---------------------+
                // | No. of bytes | Type [Value] | Description         |
                // +--------------+--------------+---------------------+
                // | 1            | U8 [2]       | message-type        |
                // | 1            |              | padding             |
                // | 2            | U16          | number-of-encodings |
                // +--------------+--------------+---------------------+

                // This is followed by number-of-encodings repetitions of the following:
                // +--------------+--------------+---------------+
                // | No. of bytes | Type [Value] | Description   |
                // +--------------+--------------+---------------+
                // | 4            | S32          | encoding-type |
                // +--------------+--------------+---------------+
                let mut payload = vec![2, 0];
                payload.extend_from_slice(&(encodings.len() as u16).to_be_bytes());
                for e in encodings {
                    payload.write_u32(e.into()).await?;
                }
                writer.write_all(&payload).await?;
                Ok(())
            }
            ClientMsg::FramebufferUpdateRequest(rect, incremental) => {
                // +--------------+--------------+--------------+
                // | No. of bytes | Type [Value] | Description  |
                // +--------------+--------------+--------------+
                // | 1            | U8 [3]       | message-type |
                // | 1            | U8           | incremental  |
                // | 2            | U16          | x-position   |
                // | 2            | U16          | y-position   |
                // | 2            | U16          | width        |
                // | 2            | U16          | height       |
                // +--------------+--------------+--------------+
                let mut payload = vec![3, incremental];
                payload.extend_from_slice(&rect.x.to_be_bytes());
                payload.extend_from_slice(&rect.y.to_be_bytes());
                payload.extend_from_slice(&rect.width.to_be_bytes());
                payload.extend_from_slice(&rect.height.to_be_bytes());
                writer.write_all(&payload).await?;
                Ok(())
            }
            ClientMsg::KeyEvent(keycode, down) => {
                // +--------------+--------------+--------------+
                // | No. of bytes | Type [Value] | Description  |
                // +--------------+--------------+--------------+
                // | 1            | U8 [4]       | message-type |
                // | 1            | U8           | down-flag    |
                // | 2            |              | padding      |
                // | 4            | U32          | key          |
                // +--------------+--------------+--------------+
                let mut payload = vec![4, down as u8, 0, 0];
                payload.write_u32(keycode).await?;
                writer.write_all(&payload).await?;
                Ok(())
            }
            ClientMsg::PointerEvent(x, y, mask) => {
                // +--------------+--------------+--------------+
                // | No. of bytes | Type [Value] | Description  |
                // +--------------+--------------+--------------+
                // | 1            | U8 [5]       | message-type |
                // | 1            | U8           | button-mask  |
                // | 2            | U16          | x-position   |
                // | 2            | U16          | y-position   |
                // +--------------+--------------+--------------+
                let mut payload = vec![5, mask];
                payload.write_u16(x).await?;
                payload.write_u16(y).await?;
                writer.write_all(&payload).await?;
                Ok(())
            }
            ClientMsg::ClientCutText(s) => {
                //   +--------------+--------------+--------------+
                //   | No. of bytes | Type [Value] | Description  |
                //   +--------------+--------------+--------------+
                //   | 1            | U8 [6]       | message-type |
                //   | 3            |              | padding      |
                //   | 4            | U32          | length       |
                //   | length       | U8 array     | text         |
                //   +--------------+--------------+--------------+
                let bytes = encode_cut_text(&s);
                let mut payload = vec![6_u8, 0, 0, 0];
                payload.write_u32(bytes.len() as u32).await?;
                payload.write_all(&bytes).await?;
                writer.write_all(&payload).await?;
                Ok(())
            }
        }
    }
}

#[derive(Debug)]
pub(super) enum ServerMsg {
    FramebufferUpdate(u16),
    // SetColorMapEntries,
    Bell,
    ServerCutText(String),
    /// A `ServerCutText` over [`MAX_SERVER_CUT_TEXT_BYTES`] was discarded
    /// (termiHub fork, PROD-021); carries the announced length.
    ServerCutTextDropped(u32),
}

impl ServerMsg {
    pub(super) async fn read<S>(reader: &mut S) -> Result<Self, VncError>
    where
        S: AsyncRead + Unpin,
    {
        let server_msg = reader.read_u8().await?;

        match server_msg {
            0 => {
                // FramebufferUpdate
                //   +--------------+--------------+----------------------+
                //   | No. of bytes | Type [Value] | Description          |
                //   +--------------+--------------+----------------------+
                //   | 1            | U8 [0]       | message-type         |
                //   | 1            |              | padding              |
                //   | 2            | U16          | number-of-rectangles |
                //   +--------------+--------------+----------------------+
                let _padding = reader.read_u8().await?;
                let rects = reader.read_u16().await?;
                Ok(ServerMsg::FramebufferUpdate(rects))
            }
            1 => {
                // SetColorMapEntries
                // +--------------+--------------+------------------+
                // | No. of bytes | Type [Value] | Description      |
                // +--------------+--------------+------------------+
                // | 1            | U8 [1]       | message-type     |
                // | 1            |              | padding          |
                // | 2            | U16          | first-color      |
                // | 2            | U16          | number-of-colors |
                // +--------------+--------------+------------------+
                unimplemented!()
            }
            2 => {
                // Bell
                //   +--------------+--------------+--------------+
                //   | No. of bytes | Type [Value] | Description  |
                //   +--------------+--------------+--------------+
                //   | 1            | U8 [2]       | message-type |
                //   +--------------+--------------+--------------+
                Ok(ServerMsg::Bell)
            }
            3 => {
                // ServerCutText
                // +--------------+--------------+--------------+
                // | No. of bytes | Type [Value] | Description  |
                // +--------------+--------------+--------------+
                // | 1            | U8 [3]       | message-type |
                // | 3            |              | padding      |
                // | 4            | U32          | length       |
                // | length       | U8 array     | text         |
                // +--------------+--------------+--------------+
                let mut padding = [0; 3];
                reader.read_exact(&mut padding).await?;
                let len = reader.read_u32().await?;
                if len > MAX_SERVER_CUT_TEXT_BYTES {
                    // Skip the payload without buffering it, so the stream stays
                    // aligned on the next message.
                    let skipped = tokio::io::copy(
                        &mut (&mut *reader).take(u64::from(len)),
                        &mut tokio::io::sink(),
                    )
                    .await?;
                    if skipped < u64::from(len) {
                        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
                    }
                    return Ok(Self::ServerCutTextDropped(len));
                }
                let mut buffer_str = vec![0; len as usize];
                reader.read_exact(&mut buffer_str).await?;
                Ok(Self::ServerCutText(decode_cut_text(buffer_str)))
            }
            _ => Err(VncError::WrongServerMessage),
        }
    }
}

#[cfg(test)]
mod cut_text_tests {
    use super::*;

    fn server_cut_text(payload: &[u8], announced: u32) -> Vec<u8> {
        let mut msg = vec![3_u8, 0, 0, 0];
        msg.extend_from_slice(&announced.to_be_bytes());
        msg.extend_from_slice(payload);
        msg
    }

    #[test]
    fn decodes_latin1_bytes_that_are_not_utf8() {
        // "café" in Latin-1: 0xE9 alone is invalid UTF-8.
        assert_eq!(decode_cut_text(vec![b'c', b'a', b'f', 0xE9]), "café");
    }

    #[test]
    fn keeps_valid_utf8() {
        assert_eq!(
            decode_cut_text("日本 café".as_bytes().to_vec()),
            "日本 café"
        );
    }

    #[test]
    fn encodes_latin1_representable_text_as_latin1() {
        assert_eq!(encode_cut_text("café"), vec![b'c', b'a', b'f', 0xE9]);
        assert_eq!(encode_cut_text("plain"), b"plain".to_vec());
    }

    #[test]
    fn encodes_text_beyond_latin1_as_utf8() {
        assert_eq!(encode_cut_text("日本"), "日本".as_bytes().to_vec());
    }

    #[tokio::test]
    async fn reads_a_latin1_server_cut_text() {
        let bytes = server_cut_text(&[b'n', 0xE4, b'h'], 3);
        let msg = ServerMsg::read(&mut bytes.as_slice()).await.unwrap();
        assert!(matches!(msg, ServerMsg::ServerCutText(t) if t == "näh"));
    }

    #[tokio::test]
    async fn skips_an_oversize_server_cut_text_and_stays_in_sync() {
        let len = MAX_SERVER_CUT_TEXT_BYTES + 1;
        let mut bytes = server_cut_text(&vec![b'x'; len as usize], len);
        bytes.push(2); // a Bell right after it
        let mut reader = bytes.as_slice();
        let msg = ServerMsg::read(&mut reader).await.unwrap();
        assert!(matches!(msg, ServerMsg::ServerCutTextDropped(n) if n == len));
        assert!(matches!(
            ServerMsg::read(&mut reader).await.unwrap(),
            ServerMsg::Bell
        ));
    }

    #[tokio::test]
    async fn a_truncated_oversize_cut_text_is_an_error_not_an_allocation() {
        // Announces u32::MAX but carries a few bytes: must not try to allocate
        // 4 GiB, and must report the truncation.
        let bytes = server_cut_text(b"abc", u32::MAX);
        assert!(ServerMsg::read(&mut bytes.as_slice()).await.is_err());
    }

    #[tokio::test]
    async fn client_cut_text_is_written_as_latin1() {
        let mut out = Vec::new();
        ClientMsg::ClientCutText("é".to_string())
            .write(&mut out)
            .await
            .unwrap();
        assert_eq!(out, vec![6, 0, 0, 0, 0, 0, 0, 1, 0xE9]);
    }
}
