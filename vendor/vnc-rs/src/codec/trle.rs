//! TRLE (encoding 15) decoder, RFC 6143 §7.7.5.
//!
//! termiHub fork (#3478): upstream decoded TRLE as if it were ZRLE without the
//! zlib layer — it read a `u32` length prefix plus that many bytes (ZRLE's
//! framing) before the tiles, used 64x64 tiles, and did not implement the
//! palette-reuse subencodings. A conformant TRLE rectangle has **no** length
//! prefix: its 16x16 tiles follow the rectangle header directly, left to right,
//! top to bottom, each starting with a subencoding byte:
//!
//! | subencoding | tile payload |
//! | --- | --- |
//! | 0 | raw: `width * height` CPIXELs |
//! | 1 | solid: one CPIXEL |
//! | 2..=16 | packed palette: that many CPIXELs, then packed indices (rows byte-padded) |
//! | 17..=126 | unused (error) |
//! | 127 | packed palette reusing the previous tile's palette |
//! | 128 | plain RLE: (CPIXEL, run length) pairs |
//! | 129 | palette RLE reusing the previous tile's palette |
//! | 130..=255 | palette RLE: `subencoding - 128` CPIXELs, then (index, run?) runs |
//!
//! The decoder reads straight from the stream and every read is bounded by the
//! tile geometry (at most 16 x 16 pixels, a 127-entry palette), so a hostile
//! server can neither force a large allocation nor panic it: malformed tiles are
//! `VncError::InvalidImageData` and a short stream is an I/O error (#3473).

use crate::{PixelFormat, Rect, VncError, VncEvent};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncReadExt};
use tracing::error;

/// TRLE tile side (RFC 6143 §7.7.5). ZRLE uses 64; TRLE uses 16.
const TILE: u16 = 16;

/// Pixels in a full tile — the upper bound of any run.
const TILE_PIXELS: usize = TILE as usize * TILE as usize;

async fn read_run_length<S>(reader: &mut S) -> Result<usize, VncError>
where
    S: AsyncRead + Unpin,
{
    let mut run_length = 1;
    loop {
        let run_length_part = reader.read_u8().await?;
        run_length += run_length_part as usize;
        // termiHub fork (#3473): no legal run exceeds one tile; stop a server
        // from spinning us through an endless run of 255 bytes.
        if run_length > TILE_PIXELS {
            return Err(VncError::InvalidImageData);
        }
        if 255 != run_length_part {
            break;
        }
    }
    Ok(run_length)
}

/// Read one CPIXEL and append it to `pixels` as a full `bpp`-byte pixel.
async fn copy_true_color<S>(
    reader: &mut S,
    pixels: &mut Vec<u8>,
    pad: bool,
    compressed_bpp: usize,
    bpp: usize,
) -> Result<(), VncError>
where
    S: AsyncRead + Unpin,
{
    let mut buf = [255; 4];
    reader
        .read_exact(&mut buf[pad as usize..pad as usize + compressed_bpp])
        .await?;
    pixels.extend_from_slice(&buf[..bpp]);
    Ok(())
}

/// Append palette entry `index`. termiHub fork (#3473): an index past the palette
/// the server sent is malformed data, not an out-of-bounds panic.
fn copy_indexed(
    palette: &[u8],
    pixels: &mut Vec<u8>,
    bpp: usize,
    index: u8,
) -> Result<(), VncError> {
    let start = index as usize * bpp;
    let entry = palette
        .get(start..start + bpp)
        .ok_or(VncError::InvalidImageData)?;
    pixels.extend_from_slice(entry);
    Ok(())
}

/// Account for a run of `run_length` pixels in a tile of `pixel_count`.
/// termiHub fork (#3473): a run overshooting the tile is malformed data —
/// upstream kept appending, producing an image larger than its rectangle.
fn advance_run(count: usize, run_length: usize, pixel_count: usize) -> Result<usize, VncError> {
    match count.checked_add(run_length) {
        Some(next) if next <= pixel_count => Ok(next),
        _ => Err(VncError::InvalidImageData),
    }
}

/// How a CPIXEL maps onto a full pixel of the negotiated format: the number of
/// bytes on the wire, whether the dropped (unused) byte comes first, and the
/// full pixel size.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct CpixelLayout {
    compressed_bpp: usize,
    pad_first: bool,
    bpp: usize,
}

impl CpixelLayout {
    /// RFC 6143 §7.7.5: a CPIXEL is a PIXEL, except that a 32-bpp true-colour
    /// format of depth <= 24 whose RGB bits all fit in the low or high three
    /// bytes is sent as those three bytes.
    fn new(format: &PixelFormat) -> Result<Self, VncError> {
        let bpp = format.bits_per_pixel as usize / 8;
        if !(1..=4).contains(&bpp) {
            return Err(VncError::WrongPixelFormat);
        }
        let pixel_mask = super::pixel_mask(format);
        let (compressed_bpp, pad_first) =
            if format.bits_per_pixel == 32 && format.true_color_flag > 0 && format.depth <= 24 {
                if pixel_mask & 0x000000ff == 0 {
                    // rgb at the most significant bits
                    // if format.big_endian_flag is set
                    // then decompressed data is excepted to be [rgb.0, rgb.1, rgb.2, alpha]
                    // otherwise the decompressed data should be [alpha, rgb.0, rgb.1, rgb.2]
                    (3, format.big_endian_flag == 0)
                } else if pixel_mask & 0xff000000 == 0 {
                    // rgb at the least significant bits
                    // if format.big_endian_flag is set
                    // then decompressed data should be [alpha, rgb.0, rgb.1, rgb.2]
                    // otherwise the decompressed data should be [rgb.0, rgb.1, rgb.2, alpha]
                    (3, format.big_endian_flag > 0)
                } else {
                    (4, false)
                }
            } else {
                (bpp, false)
            };
        Ok(Self {
            compressed_bpp,
            pad_first,
            bpp,
        })
    }
}

pub struct Decoder {
    /// The most recently transmitted palette (full `bpp`-byte pixels), for the
    /// palette-reuse subencodings 127 and 129. At most 127 entries.
    palette: Vec<u8>,
    /// The CPIXEL layout `palette` was decoded with; a pixel-format change
    /// invalidates it.
    palette_layout: Option<CpixelLayout>,
}

impl Decoder {
    pub fn new() -> Self {
        Self {
            palette: Vec::with_capacity(127 * 4),
            palette_layout: None,
        }
    }

    pub async fn decode<S, F, Fut>(
        &mut self,
        format: &PixelFormat,
        rect: &Rect,
        input: &mut S,
        output_func: &F,
    ) -> Result<(), VncError>
    where
        S: AsyncRead + Unpin,
        F: Fn(VncEvent) -> Fut,
        Fut: Future<Output = Result<(), VncError>>,
    {
        // termiHub fork (#3473): bound the server-chosen rectangle.
        super::rect_pixels(rect)?;
        let layout = CpixelLayout::new(format)?;
        if self.palette_layout != Some(layout) {
            self.palette.clear();
            self.palette_layout = Some(layout);
        }

        let mut y = 0;
        while y < rect.height {
            // `rect.height - y < TILE` rather than `y + TILE > height`, which
            // overflows `u16` for a rectangle near 65535 rows.
            let height = (rect.height - y).min(TILE);
            let mut x = 0;
            while x < rect.width {
                let width = (rect.width - x).min(TILE);
                let pixels = self.decode_tile(input, layout, width, height).await?;
                output_func(VncEvent::RawImage(
                    Rect {
                        x: rect.x.checked_add(x).ok_or(VncError::InvalidImageData)?,
                        y: rect.y.checked_add(y).ok_or(VncError::InvalidImageData)?,
                        width,
                        height,
                    },
                    pixels,
                ))
                .await?;
                x += width;
            }
            y += height;
        }

        Ok(())
    }

    /// Read `count` palette CPIXELs from the stream into `self.palette`.
    async fn read_palette<S>(
        &mut self,
        input: &mut S,
        layout: CpixelLayout,
        count: u8,
    ) -> Result<(), VncError>
    where
        S: AsyncRead + Unpin,
    {
        self.palette.clear();
        for _ in 0..count {
            copy_true_color(
                input,
                &mut self.palette,
                layout.pad_first,
                layout.compressed_bpp,
                layout.bpp,
            )
            .await?;
        }
        Ok(())
    }

    /// Entries in the current palette. Reusing a palette before any was sent is
    /// malformed data.
    fn reused_palette_size(&self, bpp: usize) -> Result<usize, VncError> {
        match self.palette.len() / bpp {
            0 => Err(VncError::InvalidImageData),
            n => Ok(n),
        }
    }

    /// Decode one `width x height` tile (both <= 16) into full pixels.
    async fn decode_tile<S>(
        &mut self,
        input: &mut S,
        layout: CpixelLayout,
        width: u16,
        height: u16,
    ) -> Result<Vec<u8>, VncError>
    where
        S: AsyncRead + Unpin,
    {
        let bpp = layout.bpp;
        let pixel_count = width as usize * height as usize;
        let mut pixels = Vec::with_capacity(pixel_count * bpp);
        let subencoding = input.read_u8().await?;
        match subencoding {
            0 => {
                // Raw CPIXELs.
                for _ in 0..pixel_count {
                    copy_true_color(
                        input,
                        &mut pixels,
                        layout.pad_first,
                        layout.compressed_bpp,
                        bpp,
                    )
                    .await?;
                }
            }
            1 => {
                // Solid tile.
                let mut pixel = Vec::with_capacity(bpp);
                copy_true_color(
                    input,
                    &mut pixel,
                    layout.pad_first,
                    layout.compressed_bpp,
                    bpp,
                )
                .await?;
                for _ in 0..pixel_count {
                    pixels.extend_from_slice(&pixel);
                }
            }
            2..=16 | 127 => {
                // Packed palette (127: reuse the previous palette).
                let palette_size = if subencoding == 127 {
                    self.reused_palette_size(bpp)?
                } else {
                    self.read_palette(input, layout, subencoding).await?;
                    subencoding as usize
                };
                let bits_per_index: usize = match palette_size {
                    2 => 1,
                    3..=4 => 2,
                    5..=16 => 4,
                    // A reused palette from a palette-RLE tile can be larger
                    // than any packed palette.
                    _ => return Err(VncError::InvalidImageData),
                };
                let mask = (1u8 << bits_per_index) - 1;
                // Each row is padded to a whole byte: at most 16 px x 4 bits.
                let row_bytes = (width as usize * bits_per_index).div_ceil(8);
                let mut row = [0u8; TILE as usize * 4 / 8];
                for _ in 0..height {
                    input.read_exact(&mut row[..row_bytes]).await?;
                    for i in 0..width as usize {
                        let bit = i * bits_per_index;
                        let shift = 8 - bits_per_index - bit % 8;
                        let index = (row[bit / 8] >> shift) & mask;
                        copy_indexed(&self.palette, &mut pixels, bpp, index)?;
                    }
                }
            }
            128 => {
                // Plain RLE: (CPIXEL, run length) pairs.
                let mut count = 0;
                let mut pixel = Vec::with_capacity(bpp);
                while count < pixel_count {
                    pixel.clear();
                    copy_true_color(
                        input,
                        &mut pixel,
                        layout.pad_first,
                        layout.compressed_bpp,
                        bpp,
                    )
                    .await?;
                    let run_length = read_run_length(input).await?;
                    count = advance_run(count, run_length, pixel_count)?;
                    for _ in 0..run_length {
                        pixels.extend_from_slice(&pixel);
                    }
                }
            }
            129..=255 => {
                // Palette RLE (129: reuse the previous palette).
                if subencoding == 129 {
                    self.reused_palette_size(bpp)?;
                } else {
                    self.read_palette(input, layout, subencoding - 128).await?;
                }
                let mut count = 0;
                while count < pixel_count {
                    let control = input.read_u8().await?;
                    let index = control & 0x7f;
                    let run_length = if control & 0x80 > 0 {
                        read_run_length(input).await?
                    } else {
                        1
                    };
                    count = advance_run(count, run_length, pixel_count)?;
                    for _ in 0..run_length {
                        copy_indexed(&self.palette, &mut pixels, bpp, index)?;
                    }
                }
            }
            17..=126 => {
                error!("TRLE: unused subencoding {subencoding}");
                return Err(VncError::InvalidImageData);
            }
        }
        Ok(pixels)
    }
}

#[cfg(test)]
mod tests {
    //! Spec-conformant TRLE rectangles (RFC 6143 §7.7.5) — no length prefix,
    //! 16x16 tiles — plus malformed / truncated input (#3478).

    use super::*;
    use std::sync::Mutex;

    /// 32-bpp, depth 24, RGB in the low three bytes: CPIXELs are 3 bytes on the
    /// wire and decode to `[r, g, b, 255]`.
    fn pf() -> PixelFormat {
        PixelFormat::rgba()
    }

    fn pf_8bpp() -> PixelFormat {
        let mut pf = PixelFormat::rgba();
        pf.bits_per_pixel = 8;
        pf.depth = 8;
        pf.red_max = 7;
        pf.green_max = 7;
        pf.blue_max = 3;
        pf.red_shift = 0;
        pf.green_shift = 3;
        pf.blue_shift = 6;
        pf
    }

    const A: [u8; 4] = [1, 2, 3, 255];
    const B: [u8; 4] = [4, 5, 6, 255];
    const C: [u8; 4] = [7, 8, 9, 255];
    const D: [u8; 4] = [10, 11, 12, 255];

    fn rect(width: u16, height: u16) -> Rect {
        Rect {
            x: 100,
            y: 200,
            width,
            height,
        }
    }

    /// Decode `bytes` as one TRLE rectangle, returning the result, the emitted
    /// tiles and the bytes the decoder left unread.
    async fn decode_with(
        decoder: &mut Decoder,
        format: &PixelFormat,
        r: Rect,
        bytes: &[u8],
    ) -> (Result<(), VncError>, Vec<(Rect, Vec<u8>)>, usize) {
        let events = Mutex::new(Vec::new());
        let output = |e: VncEvent| {
            if let VncEvent::RawImage(r, p) = e {
                events.lock().unwrap().push((r, p));
            }
            std::future::ready(Ok::<(), VncError>(()))
        };
        let mut reader = bytes;
        let result = decoder.decode(format, &r, &mut reader, &output).await;
        (result, events.into_inner().unwrap(), reader.len())
    }

    async fn decode(r: Rect, bytes: &[u8]) -> (Result<(), VncError>, Vec<(Rect, Vec<u8>)>, usize) {
        decode_with(&mut Decoder::new(), &pf(), r, bytes).await
    }

    fn image(pixels: &[[u8; 4]]) -> Vec<u8> {
        pixels.concat()
    }

    /// Asserts a single-tile rectangle decoded to `expected` and consumed
    /// exactly its bytes (the trailing sentinel byte stays unread).
    async fn assert_single_tile(r: Rect, mut bytes: Vec<u8>, expected: &[[u8; 4]]) {
        bytes.push(0xEE); // next message: must not be consumed
        let (result, tiles, left) = decode(r, &bytes).await;
        result.unwrap();
        assert_eq!(left, 1, "decoder must consume exactly the rectangle");
        assert_eq!(tiles.len(), 1);
        assert_eq!(geometry(&tiles[0].0), geometry(&r));
        assert_eq!(tiles[0].1, image(expected));
    }

    fn geometry(r: &Rect) -> (u16, u16, u16, u16) {
        (r.x, r.y, r.width, r.height)
    }

    fn is_eof(r: &Result<(), VncError>) -> bool {
        matches!(r, Err(VncError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof)
    }

    #[tokio::test]
    async fn raw_tile_has_no_length_prefix() {
        // Subencoding 0, then 2x2 CPIXELs straight from the stream.
        let bytes = vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        assert_single_tile(rect(2, 2), bytes, &[A, B, C, D]).await;
    }

    #[tokio::test]
    async fn solid_tile() {
        assert_single_tile(rect(3, 2), vec![1, 1, 2, 3], &[A; 6]).await;
    }

    #[tokio::test]
    async fn packed_palette_one_bit_rows_are_byte_padded() {
        // 3x2, 2-colour palette: 1 bit per index, each row padded to a byte.
        // Row 0: A B A -> 010x_xxxx; row 1: B B A -> 110x_xxxx.
        let bytes = vec![2, 1, 2, 3, 4, 5, 6, 0b0100_0000, 0b1100_0000];
        assert_single_tile(rect(3, 2), bytes, &[A, B, A, B, B, A]).await;
    }

    #[tokio::test]
    async fn packed_palette_two_and_four_bit_indices() {
        // 3 colours -> 2 bits: row C A B C -> 10 00 01 10.
        let bytes = vec![3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0b1000_0110];
        assert_single_tile(rect(4, 1), bytes, &[C, A, B, C]).await;
        // 5 colours -> 4 bits: 3 pixels D A C -> 0011 0000 | 0010 xxxx.
        let mut bytes = vec![5];
        for p in [A, B, C, D, A] {
            bytes.extend_from_slice(&p[..3]);
        }
        bytes.extend_from_slice(&[0x30, 0x20]);
        assert_single_tile(rect(3, 1), bytes, &[D, A, C]).await;
    }

    #[tokio::test]
    async fn plain_rle_tile() {
        // Subencoding 128: (A, run 3), (B, run 1).
        let bytes = vec![128, 1, 2, 3, 2, 4, 5, 6, 0];
        assert_single_tile(rect(2, 2), bytes, &[A, A, A, B]).await;
    }

    #[tokio::test]
    async fn plain_rle_multi_byte_run_length() {
        // A 16x16 tile as a single run of 256: 255 + 0 + 1.
        let bytes = vec![128, 1, 2, 3, 255, 0];
        assert_single_tile(rect(16, 16), bytes, &[A; 256]).await;
    }

    #[tokio::test]
    async fn palette_rle_tile() {
        // Subencoding 130 (2 colours): index 1 once, index 0 run of 3.
        let bytes = vec![130, 1, 2, 3, 4, 5, 6, 0x01, 0x80, 2];
        assert_single_tile(rect(2, 2), bytes, &[B, A, A, A]).await;
    }

    #[tokio::test]
    async fn palette_reuse_subencodings_use_the_previous_tile_palette() {
        // A 32x1 rect is two 16x1 tiles.
        // Tile 1: packed palette {A, B}, pattern A B then 14 A.
        // Tile 2 (127): reuses {A, B}, all B.
        let mut bytes = vec![2, 1, 2, 3, 4, 5, 6, 0b0100_0000, 0x00];
        bytes.extend_from_slice(&[127, 0xFF, 0xFF]);
        bytes.push(0xEE);
        let (result, tiles, left) = decode(rect(32, 1), &bytes).await;
        result.unwrap();
        assert_eq!(left, 1);
        assert_eq!(tiles.len(), 2);
        let mut first = vec![A, B];
        first.extend([A; 14]);
        assert_eq!(tiles[0].1, image(&first));
        assert_eq!(geometry(&tiles[1].0), (116, 200, 16, 1));
        assert_eq!(tiles[1].1, image(&[B; 16]));

        // 129 reuses a palette-RLE palette across rectangles.
        let mut decoder = Decoder::new();
        let bytes = [131, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0x02];
        let (result, _, _) = decode_with(&mut decoder, &pf(), rect(1, 1), &bytes).await;
        result.unwrap();
        let (result, tiles, left) =
            decode_with(&mut decoder, &pf(), rect(1, 1), &[129, 0x01]).await;
        result.unwrap();
        assert_eq!(left, 0);
        assert_eq!(tiles[0].1, image(&[B]));
    }

    #[tokio::test]
    async fn tiles_are_16x16_in_row_major_order() {
        // 17x17 -> tiles 16x16, 1x16, 16x1, 1x1, each solid.
        let mut bytes = Vec::new();
        for p in [A, B, C, D] {
            bytes.push(1);
            bytes.extend_from_slice(&p[..3]);
        }
        let (result, tiles, left) = decode(rect(17, 17), &bytes).await;
        result.unwrap();
        assert_eq!(left, 0);
        let layout: Vec<_> = tiles.iter().map(|(r, _)| geometry(r)).collect();
        assert_eq!(
            layout,
            [
                (100, 200, 16, 16),
                (116, 200, 1, 16),
                (100, 216, 16, 1),
                (116, 216, 1, 1)
            ]
        );
        assert_eq!(tiles[3].1, image(&[D]));
    }

    #[tokio::test]
    async fn non_compact_cpixel_formats_send_full_pixels() {
        // 8 bpp: a CPIXEL is the 1-byte pixel.
        let (result, tiles, left) = decode_with(
            &mut Decoder::new(),
            &pf_8bpp(),
            rect(2, 1),
            &[0, 0x11, 0x22],
        )
        .await;
        result.unwrap();
        assert_eq!(left, 0);
        assert_eq!(tiles[0].1, vec![0x11, 0x22]);
    }

    #[tokio::test]
    async fn truncated_tile_is_an_io_error() {
        for bytes in [
            &[][..],
            &[0, 1, 2, 3, 4][..],       // raw, short
            &[2, 1, 2, 3, 4, 5, 6][..], // packed, no index bytes
            &[128, 1, 2, 3][..],        // RLE, no run length
            &[128, 1, 2, 3, 255][..],   // RLE, run continues past EOF
            &[130, 1, 2, 3][..],        // palette RLE, short palette
        ] {
            let (result, _, _) = decode(rect(2, 2), bytes).await;
            assert!(is_eof(&result), "{bytes:?}: {result:?}");
        }
    }

    #[tokio::test]
    async fn malformed_tiles_are_invalid_data() {
        let cases: [&[u8]; 7] = [
            // unused subencoding
            &[17],
            &[126],
            // palette reuse before any palette was sent
            &[127, 0],
            &[129, 0],
            // plain RLE run overshooting the 2x2 tile
            &[128, 1, 2, 3, 4],
            // palette RLE index past the 2-colour palette
            &[130, 1, 2, 3, 4, 5, 6, 0x05],
            // packed 3-colour palette, index 3 does not exist
            &[3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0b1100_0000, 0],
        ];
        for bytes in cases {
            let (result, _, _) = decode(rect(2, 2), bytes).await;
            assert!(
                matches!(result, Err(VncError::InvalidImageData)),
                "{bytes:?}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn endless_run_of_255_bytes_is_bounded() {
        let mut bytes = vec![128, 1, 2, 3];
        bytes.extend(std::iter::repeat_n(255, 10_000));
        let (result, _, left) = decode(rect(16, 16), &bytes).await;
        assert!(
            matches!(result, Err(VncError::InvalidImageData)),
            "{result:?}"
        );
        assert!(
            left > 9_000,
            "decoder must stop reading after one tile's worth"
        );
    }

    #[tokio::test]
    async fn reused_palette_too_large_for_packing_is_invalid_data() {
        // A 17-colour palette-RLE palette cannot be reused for packed pixels.
        let mut decoder = Decoder::new();
        let mut bytes = vec![128 + 17];
        bytes.extend(std::iter::repeat_n(0, 17 * 3));
        bytes.push(0);
        let (result, _, _) = decode_with(&mut decoder, &pf(), rect(1, 1), &bytes).await;
        result.unwrap();
        let (result, _, _) = decode_with(&mut decoder, &pf(), rect(1, 1), &[127, 0]).await;
        assert!(
            matches!(result, Err(VncError::InvalidImageData)),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn oversize_rect_is_rejected_before_reading() {
        let (result, tiles, left) = decode(rect(u16::MAX, u16::MAX), &[1, 1, 2, 3]).await;
        assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
        assert!(tiles.is_empty());
        assert_eq!(left, 4);
    }
}
