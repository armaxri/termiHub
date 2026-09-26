use crate::{PixelFormat, Rect, VncError, VncEvent};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncReadExt};
use tracing::error;

use super::zeroed_vec;

async fn read_run_length<S>(reader: &mut S) -> Result<usize, VncError>
where
    S: AsyncRead + Unpin,
{
    let mut run_length_part;
    let mut run_length = 1;
    loop {
        run_length_part = reader.read_u8().await?;
        run_length += run_length_part as usize;
        // termiHub fork (#3473): no legal run exceeds one 64x64 tile; stop a
        // server from spinning us through an endless run of 255 bytes.
        if run_length > 64 * 64 {
            return Err(VncError::InvalidImageData);
        }
        if 255 != run_length_part {
            break;
        }
    }
    Ok(run_length)
}

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

pub struct Decoder {}

impl Decoder {
    pub fn new() -> Self {
        Self {}
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
        // termiHub fork (#3473): bound the server-chosen rectangle and length.
        super::rect_pixels(rect)?;
        let data_len = super::encoded_len(input.read_u32().await?)?;
        let mut zlib_data = zeroed_vec(data_len);
        input.read_exact(&mut zlib_data).await?;

        let bpp = format.bits_per_pixel as usize / 8;
        let pixel_mask = super::pixel_mask(format);

        let (compressed_bpp, alpha_at_first) =
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
        let mut palette = Vec::with_capacity(128 * bpp);

        let mut y = 0;
        while y < rect.height {
            // `rect.height - y < 64` rather than upstream's `y + 64 > height`,
            // which overflows `u16` for a rectangle near 65535 rows.
            let height = if rect.height - y < 64 {
                rect.height - y
            } else {
                64
            };
            let mut x = 0;
            while x < rect.width {
                let width = if rect.width - x < 64 {
                    rect.width - x
                } else {
                    64
                };
                let pixel_count = height as usize * width as usize;

                let control = input.read_u8().await?;
                let is_rle = control & 0x80 > 0;
                let palette_size = control & 0x7f;
                palette.clear();

                for _ in 0..palette_size {
                    copy_true_color(input, &mut palette, alpha_at_first, compressed_bpp, bpp)
                        .await?
                }

                let mut pixels = Vec::with_capacity(pixel_count * bpp);
                match (is_rle, palette_size) {
                    (false, 0) => {
                        // True Color pixels
                        for _ in 0..pixel_count {
                            copy_true_color(input, &mut pixels, alpha_at_first, compressed_bpp, bpp)
                                .await?
                        }
                    }
                    (false, 1) => {
                        // Color fill
                        for _ in 0..pixel_count {
                            copy_indexed(&palette, &mut pixels, bpp, 0)?;
                        }
                    }
                    (false, 2..=16) => {
                        // Indexed pixels
                        let bits_per_index = if palette_size == 2 {
                            1
                        } else if palette_size <= 4 {
                            2
                        } else {
                            4
                        };
                        let mut encoded = input.read_u8().await?;
                        let mask = (1 << bits_per_index) - 1;

                        for y in 0..height {
                            let mut shift = 8 - bits_per_index;
                            for _ in 0..width {
                                if shift < 0 {
                                    shift = 8 - bits_per_index;
                                    encoded = input.read_u8().await?;
                                }
                                let idx = (encoded >> shift) & mask;

                                copy_indexed(&palette, &mut pixels, bpp, idx)?;
                                shift -= bits_per_index;
                            }
                            if shift < 8 - bits_per_index && y < height - 1 {
                                encoded = input.read_u8().await?;
                            }
                        }
                    }
                    (true, 0) => {
                        // True Color RLE
                        let mut count = 0;
                        let mut pixel = Vec::new();
                        while count < pixel_count {
                            pixel.clear();
                            copy_true_color(input, &mut pixel, alpha_at_first, compressed_bpp, bpp)
                                .await?;
                            let run_length = read_run_length(input).await?;
                            count = advance_run(count, run_length, pixel_count)?;
                            for _ in 0..run_length {
                                pixels.extend(&pixel)
                            }
                        }
                    }
                    (true, 2..=127) => {
                        // Indexed RLE
                        let mut count = 0;
                        while count < pixel_count {
                            let control = input.read_u8().await?;
                            let longer_than_one = control & 0x80 > 0;
                            let index = control & 0x7f;
                            let run_length = if longer_than_one {
                                read_run_length(input).await?
                            } else {
                                1
                            };
                            count = advance_run(count, run_length, pixel_count)?;
                            for _ in 0..run_length {
                                copy_indexed(&palette, &mut pixels, bpp, index)?;
                            }
                        }
                    }
                    (x, y) => {
                        error!("TLRE subencoding error {:?}", (x, y));
                        return Err(VncError::InvalidImageData);
                    }
                }
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
}
