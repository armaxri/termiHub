use crate::{PixelFormat, Rect, VncError, VncEvent};
use std::future::Future;
use std::io::Read;
use tokio::io::{AsyncRead, AsyncReadExt};
use tracing::error;

use super::{pixel_value, push_pixel, shl_or_zero, zeroed_vec, zlib::ZlibReader};

const MAX_PALETTE: usize = 256;

#[derive(Default)]
pub struct Decoder {
    zlibs: [Option<flate2::Decompress>; 4],
    ctrl: u8,
    filter: u8,
    palette: Vec<u8>,
    alpha_shift: u32,
    /// Wire size of one TPIXEL for the current rectangle's pixel format: 3 for
    /// the packed 24-bit case, otherwise the format's bytes per pixel.
    tpixel_len: usize,
    /// `true` when TPIXELs are full pixels in the negotiated format (every
    /// true-colour format except 32 bpp with 8-bit channels), emitted as-is.
    native: bool,
}

impl Decoder {
    pub fn new() -> Self {
        let mut new = Self {
            palette: Vec::with_capacity(MAX_PALETTE * 4),
            ..Default::default()
        };
        for i in 0..4 {
            let decompressor = flate2::Decompress::new(true);
            new.zlibs[i] = Some(decompressor);
        }
        new
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
        // termiHub fork (#3473, #3499, #3464): a 32-bpp format with three 8-bit
        // channels uses 3-byte TPIXELs expanded to the negotiated layout; every
        // other valid true-colour format (16-bit high colour, 8-bit true colour)
        // uses full PIXELs, emitted unchanged in the negotiated format. Colour-map
        // and malformed formats are a typed error (upstream: `unreachable!()`),
        // and the rectangle size is bounded before anything is allocated.
        self.select_layout(format)?;
        super::rect_pixels(rect)?;

        let ctrl = input.read_u8().await?;
        for (i, zlib) in self.zlibs.iter_mut().enumerate() {
            if (ctrl >> i) & 1 == 1 {
                // A reset starts a fresh zlib stream, which is exactly a new
                // decompressor — and never unwraps a slot a failed decode left
                // empty.
                *zlib = Some(flate2::Decompress::new(true));
            }
        }

        // Figure out filter
        self.ctrl = ctrl >> 4;

        match self.ctrl {
            8 => {
                // fill Rect
                self.fill_rect(format, rect, input, output_func).await
            }
            9 => {
                // jpeg Rect
                self.jpeg_rect(format, rect, input, output_func).await
            }
            10 => {
                // png Rect
                error!("PNG received in standard Tight rect");
                Err(VncError::InvalidImageData)
            }
            x if x & 0x8 == 0 => {
                // basic Rect
                self.basic_rect(format, rect, input, output_func).await
            }
            _ => {
                error!("Illegal tight compression received ({})", self.ctrl);
                Err(VncError::InvalidImageData)
            }
        }
    }

    /// Pick the TPIXEL layout for `format` (see [`Self::tpixel_len`]).
    fn select_layout(&mut self, format: &PixelFormat) -> Result<(), VncError> {
        if format.true_color_flag == 0 {
            return Err(VncError::WrongPixelFormat);
        }
        if format.bits_per_pixel == 32
            && [format.red_max, format.green_max, format.blue_max] == [255; 3]
        {
            self.alpha_shift = super::alpha_shift(format)?;
            self.tpixel_len = 3;
            self.native = false;
        } else {
            format.validate()?;
            self.tpixel_len = format.bits_per_pixel as usize / 8;
            self.native = true;
        }
        Ok(())
    }

    /// Append the negotiated-format pixel for one TPIXEL.
    fn push_tpixel(&self, format: &PixelFormat, tpixel: &[u8], image: &mut Vec<u8>) {
        if self.native {
            image.extend_from_slice(tpixel);
        } else {
            image.extend_from_slice(&self.to_true_color(format, tpixel));
        }
    }

    async fn read_data<S>(&mut self, input: &mut S) -> Result<Vec<u8>, VncError>
    where
        S: AsyncRead + Unpin,
    {
        let len = {
            let mut len;
            let mut byte = input.read_u8().await? as usize;
            len = byte & 0x7f;
            if byte & 0x80 == 0x80 {
                byte = input.read_u8().await? as usize;
                len |= (byte & 0x7f) << 7;

                if byte & 0x80 == 0x80 {
                    byte = input.read_u8().await? as usize;
                    len |= byte << 14;
                }
            }
            len
        };
        let mut data = zeroed_vec(len);
        input.read_exact(&mut data).await?;
        Ok(data)
    }

    async fn fill_rect<S, F, Fut>(
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
        let mut color = [0; 4];
        let color = &mut color[..self.tpixel_len];
        input.read_exact(color).await?;
        let bpp = format.bits_per_pixel as usize / 8;
        let mut image = Vec::with_capacity(rect.width as usize * rect.height as usize * bpp);

        let mut pixel = Vec::with_capacity(4);
        self.push_tpixel(format, color, &mut pixel);

        for _ in 0..rect.width {
            for _ in 0..rect.height {
                image.extend_from_slice(&pixel);
            }
        }
        output_func(VncEvent::RawImage(*rect, image)).await?;
        Ok(())
    }

    async fn jpeg_rect<S, F, Fut>(
        &mut self,
        _format: &PixelFormat,
        rect: &Rect,
        input: &mut S,
        output_func: &F,
    ) -> Result<(), VncError>
    where
        S: AsyncRead + Unpin,
        F: Fn(VncEvent) -> Fut,
        Fut: Future<Output = Result<(), VncError>>,
    {
        let data = self.read_data(input).await?;
        output_func(VncEvent::JpegImage(*rect, data)).await?;
        Ok(())
    }

    async fn basic_rect<S, F, Fut>(
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
        self.filter = {
            if self.ctrl & 0x4 == 4 {
                input.read_u8().await?
            } else {
                0
            }
        };

        let stream_id = self.ctrl & 0x3;
        match self.filter {
            0 => {
                // copy filter
                self.copy_filter(stream_id, format, rect, input, output_func)
                    .await
            }
            1 => {
                // palette
                self.palette_filter(stream_id, format, rect, input, output_func)
                    .await
            }
            2 => {
                // gradient
                self.gradient_filter(stream_id, format, rect, input, output_func)
                    .await
            }
            _ => {
                error!("Illegal tight filter received (filter: {})", self.filter);
                Err(VncError::InvalidImageData)
            }
        }
    }

    async fn copy_filter<S, F, Fut>(
        &mut self,
        stream: u8,
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
        let uncompressed_size = rect.width as usize * rect.height as usize * self.tpixel_len;
        if uncompressed_size == 0 {
            return Ok(());
        };

        let data = self
            .read_tight_data(stream, input, uncompressed_size)
            .await?;
        if self.native {
            // termiHub fork (#3464): TPIXELs are already negotiated-format pixels.
            output_func(VncEvent::RawImage(*rect, data)).await?;
            return Ok(());
        }
        let mut image = Vec::with_capacity(uncompressed_size / 3 * 4);
        let mut j = 0;
        while j < uncompressed_size {
            image.extend_from_slice(&self.to_true_color(format, &data[j..j + 3]));
            j += 3;
        }

        output_func(VncEvent::RawImage(*rect, image)).await?;

        Ok(())
    }

    async fn palette_filter<S, F, Fut>(
        &mut self,
        stream: u8,
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
        let num_colors = input.read_u8().await? as usize + 1;
        let palette_size = num_colors * self.tpixel_len;

        self.palette = zeroed_vec(palette_size);
        input.read_exact(&mut self.palette).await?;

        // Only a two-colour palette is bit-packed; one colour uses a byte per
        // pixel like any other palette (upstream packed it and then indexed the
        // packed data per pixel — out of bounds).
        let bpp = if num_colors == 2 { 1 } else { 8 };
        let row_size = (rect.width as usize * bpp).div_ceil(8);
        let uncompressed_size = rect.height as usize * row_size;

        if uncompressed_size == 0 {
            return Ok(());
        }

        let data = self
            .read_tight_data(stream, input, uncompressed_size)
            .await?;

        if num_colors == 2 {
            self.mono_rect(data, rect, format, output_func).await?
        } else {
            self.palette_rect(data, rect, format, output_func).await?
        }

        Ok(())
    }

    async fn mono_rect<F, Fut>(
        &mut self,
        data: Vec<u8>,
        rect: &Rect,
        format: &PixelFormat,
        output_func: &F,
    ) -> Result<(), VncError>
    where
        F: Fn(VncEvent) -> Fut,
        Fut: Future<Output = Result<(), VncError>>,
    {
        // Convert indexed (palette based) image data to RGB
        let width = rect.width as usize;
        let total = width * rect.height as usize;
        let mut image = Vec::with_capacity(total * 4);
        let mut offset = 8_usize;
        let mut index = 0_usize;
        for i in 0..total {
            if i != 0 && (offset == 0 || i % width == 0) {
                offset = 8;
                index += 1;
            }
            offset -= 1;
            let byte = *data.get(index).ok_or(VncError::InvalidImageData)?;
            let sp = ((byte >> offset) & 0x01) as usize * self.tpixel_len;
            let entry = self
                .palette
                .get(sp..sp + self.tpixel_len)
                .ok_or(VncError::InvalidImageData)?;
            self.push_tpixel(format, entry, &mut image);
        }
        output_func(VncEvent::RawImage(*rect, image)).await?;
        Ok(())
    }

    async fn palette_rect<F, Fut>(
        &mut self,
        data: Vec<u8>,
        rect: &Rect,
        format: &PixelFormat,
        output_func: &F,
    ) -> Result<(), VncError>
    where
        F: Fn(VncEvent) -> Fut,
        Fut: Future<Output = Result<(), VncError>>,
    {
        // Convert indexed (palette based) image data to RGB
        let total = rect.width as usize * rect.height as usize;
        let mut image = Vec::with_capacity(total * 4);
        for &index in data.iter().take(total) {
            // termiHub fork (#3473): a palette index past the palette the server
            // sent is malformed data, not a panic.
            let sp = index as usize * self.tpixel_len;
            let entry = self
                .palette
                .get(sp..sp + self.tpixel_len)
                .ok_or(VncError::InvalidImageData)?;
            self.push_tpixel(format, entry, &mut image);
        }
        output_func(VncEvent::RawImage(*rect, image)).await?;
        Ok(())
    }

    async fn gradient_filter<S, F, Fut>(
        &mut self,
        stream: u8,
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
        let uncompressed_size = rect.width as usize * rect.height as usize * self.tpixel_len;
        if uncompressed_size == 0 {
            return Ok(());
        };
        let data = self
            .read_tight_data(stream, input, uncompressed_size)
            .await?;
        if self.native {
            let image = gradient_native(format, rect, self.tpixel_len, &data)?;
            output_func(VncEvent::RawImage(*rect, image)).await?;
            return Ok(());
        }
        let mut image = Vec::with_capacity(rect.width as usize * rect.height as usize * 4);

        let row_len = rect.width as usize * 3 + 3;
        let mut row_0 = vec![0_u16; row_len];
        let mut row_1 = vec![0_u16; row_len];
        let max = [format.red_max, format.green_max, format.blue_max];
        let shift = [format.red_shift, format.green_shift, format.blue_shift];
        let mut sp = 0;

        for y in 0..rect.height as usize {
            let (this_row, prev_row) = if y & 1 == 0 {
                (&mut row_0, &mut row_1)
            } else {
                (&mut row_1, &mut row_0)
            };
            let mut x = 3;
            while x < row_len {
                let rgb = data.get(sp..sp + 3).ok_or(VncError::InvalidImageData)?;
                let mut color = 0;
                for index in 0..3 {
                    let d = prev_row[index + x] as i32 + this_row[index + x - 3] as i32
                        - prev_row[index + x - 3] as i32;
                    let converted = if d < 0 {
                        0
                    } else if d > max[index] as i32 {
                        max[index]
                    } else {
                        d as u16
                    };
                    this_row[index + x] = converted.wrapping_add(rgb[index] as u16) & max[index];
                    color |=
                        shl_or_zero(this_row[x + index] as u32 & max[index] as u32, shift[index]);
                }
                image.extend_from_slice(&color.to_le_bytes());
                sp += 3;
                x += 3;
            }
        }

        output_func(VncEvent::RawImage(*rect, image)).await?;
        Ok(())
    }

    async fn read_tight_data<S>(
        &mut self,
        stream: u8,
        input: &mut S,
        uncompressed_size: usize,
    ) -> Result<Vec<u8>, VncError>
    where
        S: AsyncRead + Unpin,
    {
        let mut data;
        if uncompressed_size < 12 {
            data = zeroed_vec(uncompressed_size);
            input.read_exact(&mut data).await?;
        } else {
            let d = self.read_data(input).await?;
            // termiHub fork (#3473): a slot left empty by an earlier failed
            // decode is an error, not an `unwrap()` panic.
            let zlib = self
                .zlibs
                .get_mut(stream as usize)
                .and_then(Option::take)
                .ok_or(VncError::InvalidImageData)?;
            let mut reader = ZlibReader::new(zlib, &d);
            data = zeroed_vec(uncompressed_size);
            reader.read_exact(&mut data)?;
            self.zlibs[stream as usize] = Some(reader.into_inner()?);
        };
        Ok(data)
    }

    fn to_true_color(&self, format: &PixelFormat, color: &[u8]) -> [u8; 4] {
        let alpha = 255;
        // always rgb
        (shl_or_zero(color[0] as u32 & format.red_max as u32, format.red_shift)
            | shl_or_zero(
                color[1] as u32 & format.green_max as u32,
                format.green_shift,
            )
            | shl_or_zero(color[2] as u32 & format.blue_max as u32, format.blue_shift)
            | ((alpha as u32) << self.alpha_shift))
            .to_le_bytes()
    }
}

/// Undo Tight's gradient filter for a format whose TPIXELs are full pixels
/// (termiHub fork, #3464; RFC-less Tight spec / libvncclient `FilterGradientBPP`).
///
/// Each wire pixel carries, per channel, the difference to the prediction
/// `up + left - up_left` (clamped to `0..=max`), packed with the format's own
/// shifts and endianness. The result is a negotiated-format pixel buffer.
fn gradient_native(
    format: &PixelFormat,
    rect: &Rect,
    bytes_per_pixel: usize,
    data: &[u8],
) -> Result<Vec<u8>, VncError> {
    let width = rect.width as usize;
    let max = [format.red_max, format.green_max, format.blue_max].map(u32::from);
    let shift = [format.red_shift, format.green_shift, format.blue_shift];
    let mut prev_row = vec![[0_u32; 3]; width];
    let mut this_row = vec![[0_u32; 3]; width];
    let mut image = Vec::with_capacity(width * rect.height as usize * bytes_per_pixel);
    let mut sp = 0;
    for _ in 0..rect.height {
        for x in 0..width {
            let wire = data
                .get(sp..sp + bytes_per_pixel)
                .ok_or(VncError::InvalidImageData)?;
            let diff = pixel_value(format, wire);
            let mut pixel = 0;
            for c in 0..3 {
                let (left, up_left) = if x > 0 {
                    (this_row[x - 1][c], prev_row[x - 1][c])
                } else {
                    (0, 0)
                };
                let estimate = (i64::from(prev_row[x][c]) + i64::from(left) - i64::from(up_left))
                    .clamp(0, i64::from(max[c])) as u32;
                let delta = diff.checked_shr(u32::from(shift[c])).unwrap_or(0) & max[c];
                let value = estimate.wrapping_add(delta) & max[c];
                this_row[x][c] = value;
                pixel |= shl_or_zero(value, shift[c]);
            }
            push_pixel(format, pixel, bytes_per_pixel, &mut image);
            sp += bytes_per_pixel;
        }
        std::mem::swap(&mut prev_row, &mut this_row);
    }
    Ok(image)
}
