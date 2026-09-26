use crate::VncError;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// All supported vnc encodings
///
/// termiHub fork (#3464): the enum no longer carries `#[repr(i32)]`
/// discriminants, because the Tight quality / compression-level pseudo-encodings
/// carry their level. [`VncEncoding::wire_value`] is the RFB encoding number.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VncEncoding {
    Raw,
    CopyRect,
    // Rre = 2,
    // Hextile = 5,
    Tight,
    Trle,
    Zrle,
    CursorPseudo,
    DesktopSizePseudo,
    LastRectPseudo,
    /// Tight JPEG quality level pseudo-encoding (`-32 + level`, level `0..=9`,
    /// 9 = best quality). Levels above 9 are clamped to 9 (termiHub fork, #3464).
    TightJpegQuality(u8),
    /// Tight zlib compression level pseudo-encoding (`-256 + level`, level
    /// `0..=9`, 9 = smallest output). Levels above 9 are clamped to 9 (termiHub
    /// fork, #3464).
    TightCompressLevel(u8),
}

impl VncEncoding {
    /// The signed RFB encoding number sent in `SetEncodings`.
    pub fn wire_value(self) -> i32 {
        match self {
            VncEncoding::Raw => 0,
            VncEncoding::CopyRect => 1,
            VncEncoding::Tight => 7,
            VncEncoding::Trle => 15,
            VncEncoding::Zrle => 16,
            VncEncoding::CursorPseudo => -239,
            VncEncoding::DesktopSizePseudo => -223,
            VncEncoding::LastRectPseudo => -224,
            VncEncoding::TightJpegQuality(level) => -32 + i32::from(level.min(9)),
            VncEncoding::TightCompressLevel(level) => -256 + i32::from(level.min(9)),
        }
    }
}

impl From<u32> for VncEncoding {
    fn from(num: u32) -> Self {
        // Safe match instead of transmute — unknown encoding IDs fall back to Raw
        // instead of causing UB (the original transmute is unsound for any value
        // not matching a valid discriminant).
        match num as i32 {
            0 => VncEncoding::Raw,
            1 => VncEncoding::CopyRect,
            7 => VncEncoding::Tight,
            15 => VncEncoding::Trle,
            16 => VncEncoding::Zrle,
            -239 => VncEncoding::CursorPseudo,
            -223 => VncEncoding::DesktopSizePseudo,
            -224 => VncEncoding::LastRectPseudo,
            _ => VncEncoding::Raw,
        }
    }
}

impl VncEncoding {
    /// Decode an encoding number received from the server, or `None` for one
    /// this client does not implement (termiHub fork, #3473). The lossy
    /// `From<u32>` maps unknown numbers to `Raw`, which would decode the
    /// rectangle with the wrong wire format and desynchronise the stream.
    pub(crate) fn from_wire(num: u32) -> Option<Self> {
        match num as i32 {
            0 => Some(VncEncoding::Raw),
            1 => Some(VncEncoding::CopyRect),
            7 => Some(VncEncoding::Tight),
            15 => Some(VncEncoding::Trle),
            16 => Some(VncEncoding::Zrle),
            -239 => Some(VncEncoding::CursorPseudo),
            -223 => Some(VncEncoding::DesktopSizePseudo),
            -224 => Some(VncEncoding::LastRectPseudo),
            _ => None,
        }
    }
}

impl From<VncEncoding> for u32 {
    fn from(e: VncEncoding) -> Self {
        e.wire_value() as u32
    }
}

/// All supported vnc versions
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Eq)]
#[repr(u8)]
pub enum VncVersion {
    RFB33,
    RFB37,
    RFB38,
}

impl From<[u8; 12]> for VncVersion {
    fn from(version: [u8; 12]) -> Self {
        match &version {
            b"RFB 003.003\n" => VncVersion::RFB33,
            b"RFB 003.007\n" => VncVersion::RFB37,
            b"RFB 003.008\n" => VncVersion::RFB38,
            // https://www.rfc-editor.org/rfc/rfc6143#section-7.1.1
            //  Other version numbers are reported by some servers and clients,
            //  but should be interpreted as 3.3 since they do not implement the
            //  different handshake in 3.7 or 3.8.
            _ => VncVersion::RFB33,
        }
    }
}

impl From<VncVersion> for &[u8; 12] {
    fn from(version: VncVersion) -> Self {
        match version {
            VncVersion::RFB33 => b"RFB 003.003\n",
            VncVersion::RFB37 => b"RFB 003.007\n",
            VncVersion::RFB38 => b"RFB 003.008\n",
        }
    }
}

impl VncVersion {
    pub(crate) async fn read<S>(reader: &mut S) -> Result<Self, VncError>
    where
        S: AsyncRead + Unpin,
    {
        let mut buffer = [0_u8; 12];
        reader.read_exact(&mut buffer).await?;
        Ok(buffer.into())
    }

    pub(crate) async fn write<S>(self, writer: &mut S) -> Result<(), VncError>
    where
        S: AsyncWrite + Unpin,
    {
        writer
            .write_all(&<VncVersion as Into<&[u8; 12]>>::into(self)[..])
            .await?;
        Ok(())
    }
}

///  Pixel Format Data Structure according to [RFC6143](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.4)
///
/// ```text
/// +--------------+--------------+-----------------+
/// | No. of bytes | Type [Value] | Description     |
/// +--------------+--------------+-----------------+
/// | 1            | U8           | bits-per-pixel  |
/// | 1            | U8           | depth           |
/// | 1            | U8           | big-endian-flag |
/// | 1            | U8           | true-color-flag |
/// | 2            | U16          | red-max         |
/// | 2            | U16          | green-max       |
/// | 2            | U16          | blue-max        |
/// | 1            | U8           | red-shift       |
/// | 1            | U8           | green-shift     |
/// | 1            | U8           | blue-shift      |
/// | 3            |              | padding         |
/// +--------------+--------------+-----------------+
/// ```
#[derive(Debug, Clone, Copy)]
pub struct PixelFormat {
    /// the number of bits used for each pixel value on the wire
    ///
    /// 8, 16, 32(usually) only
    ///
    pub bits_per_pixel: u8,
    /// Although the depth should
    ///
    /// be consistent with the bits-per-pixel and the various -max values,
    ///
    /// clients do not use it when interpreting pixel data.
    ///
    pub depth: u8,
    /// true if multi-byte pixels are interpreted as big endian
    ///
    pub big_endian_flag: u8,
    /// true then the last six items specify how to extract the red, green and blue intensities from the pixel value
    ///
    pub true_color_flag: u8,
    /// the next three always in big-endian order
    /// no matter how the `big_endian_flag` is set
    ///
    pub red_max: u16,
    pub green_max: u16,
    pub blue_max: u16,
    /// the number of shifts needed to get the red value in a pixel to the least significant bit
    ///
    pub red_shift: u8,
    pub green_shift: u8,
    pub blue_shift: u8,
    _padding_1: u8,
    _padding_2: u8,
    _padding_3: u8,
}

impl From<PixelFormat> for Vec<u8> {
    fn from(pf: PixelFormat) -> Vec<u8> {
        vec![
            pf.bits_per_pixel,
            pf.depth,
            pf.big_endian_flag,
            pf.true_color_flag,
            (pf.red_max >> 8) as u8,
            pf.red_max as u8,
            (pf.green_max >> 8) as u8,
            pf.green_max as u8,
            (pf.blue_max >> 8) as u8,
            pf.blue_max as u8,
            pf.red_shift,
            pf.green_shift,
            pf.blue_shift,
            pf._padding_1,
            pf._padding_2,
            pf._padding_3,
        ]
    }
}

impl TryFrom<[u8; 16]> for PixelFormat {
    type Error = VncError;

    fn try_from(pf: [u8; 16]) -> Result<Self, Self::Error> {
        let bits_per_pixel = pf[0];
        if bits_per_pixel != 8 && bits_per_pixel != 16 && bits_per_pixel != 32 {
            return Err(VncError::WrongPixelFormat);
        }
        let depth = pf[1];
        // termiHub fork (#3499, upstream 1c07e2c): RFB booleans are "non-zero is
        // true"; x11vnc sends 255. Normalise to 0/1 so every `== 1` check agrees.
        let big_endian_flag = u8::from(pf[2] != 0);
        let true_color_flag = u8::from(pf[3] != 0);
        let red_max = u16::from_be_bytes(pf[4..6].try_into().unwrap());
        let green_max = u16::from_be_bytes(pf[6..8].try_into().unwrap());
        let blue_max = u16::from_be_bytes(pf[8..10].try_into().unwrap());
        let red_shift = pf[10];
        let green_shift = pf[11];
        let blue_shift = pf[12];
        let _padding_1 = pf[13];
        let _padding_2 = pf[14];
        let _padding_3 = pf[15];
        Ok(PixelFormat {
            bits_per_pixel,
            depth,
            big_endian_flag,
            true_color_flag,
            red_max,
            green_max,
            blue_max,
            red_shift,
            green_shift,
            blue_shift,
            _padding_1,
            _padding_2,
            _padding_3,
        })
    }
}

impl Default for PixelFormat {
    // by default the pixel transformed is (a << 24 | r << 16 || g << 8 | b) in le
    // which is [b, g, r, a] in network
    fn default() -> Self {
        Self {
            bits_per_pixel: 32,
            depth: 24,
            big_endian_flag: 0,
            true_color_flag: 1,
            red_max: 255,
            green_max: 255,
            blue_max: 255,
            red_shift: 16,
            green_shift: 8,
            blue_shift: 0,
            _padding_1: 0,
            _padding_2: 0,
            _padding_3: 0,
        }
    }
}

impl PixelFormat {
    /// Structural validation of a pixel format the client will *decode with*
    /// (termiHub fork, #3499 — ported from upstream 0.6.0 `1c07e2c`).
    ///
    /// Rejects bits-per-pixel other than 8/16/32, a zero or oversized depth,
    /// non-boolean flags, and — for true-colour formats — channel maxima that are
    /// not `2^n - 1`, shifts outside the pixel, and channel masks that overflow
    /// the pixel or overlap each other. The decoders already tolerate such formats
    /// without panicking (#3473); this turns them into an early typed error.
    pub(crate) fn validate(&self) -> Result<(), VncError> {
        if !matches!(self.bits_per_pixel, 8 | 16 | 32)
            || self.depth == 0
            || self.depth > self.bits_per_pixel
            || self.big_endian_flag > 1
            || self.true_color_flag > 1
        {
            return Err(VncError::WrongPixelFormat);
        }
        if self.true_color_flag == 1 {
            let mut mask = 0u64;
            for (max, shift) in [
                (self.red_max, self.red_shift),
                (self.green_max, self.green_shift),
                (self.blue_max, self.blue_shift),
            ] {
                let max = u64::from(max);
                if max == 0 || max & (max + 1) != 0 || shift >= self.bits_per_pixel {
                    return Err(VncError::WrongPixelFormat);
                }
                let component = max << shift;
                if component >= (1u64 << self.bits_per_pixel) || component & mask != 0 {
                    return Err(VncError::WrongPixelFormat);
                }
                mask |= component;
            }
        }
        Ok(())
    }

    // (a << 24 | r << 16 || g << 8 | b) in le
    // [b, g, r, a] in network
    pub fn bgra() -> PixelFormat {
        PixelFormat::default()
    }

    // (a << 24 | b << 16 | g << 8 | r) in le
    // which is [r, g, b, a] in network
    pub fn rgba() -> PixelFormat {
        Self {
            red_shift: 0,
            blue_shift: 16,
            ..Default::default()
        }
    }

    /// 16-bit "high colour" RGB565, little-endian: red in bits 11..16 (max 31),
    /// green in bits 5..11 (max 63), blue in bits 0..5 (max 31). Half the
    /// bandwidth of the 32-bit formats (termiHub fork, #3464).
    pub fn rgb565() -> PixelFormat {
        Self {
            bits_per_pixel: 16,
            depth: 16,
            red_max: 31,
            green_max: 63,
            blue_max: 31,
            red_shift: 11,
            green_shift: 5,
            blue_shift: 0,
            ..Default::default()
        }
    }

    pub(crate) async fn read<S>(reader: &mut S) -> Result<Self, VncError>
    where
        S: AsyncRead + Unpin,
    {
        let mut pixel_buffer = [0_u8; 16];
        reader.read_exact(&mut pixel_buffer).await?;
        pixel_buffer.try_into()
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::VncEncoding;

    #[test]
    fn wire_values_match_rfc_6143() {
        let cases = [
            (VncEncoding::Raw, 0),
            (VncEncoding::CopyRect, 1),
            (VncEncoding::Tight, 7),
            (VncEncoding::Trle, 15),
            (VncEncoding::Zrle, 16),
            (VncEncoding::CursorPseudo, -239),
            (VncEncoding::DesktopSizePseudo, -223),
            (VncEncoding::LastRectPseudo, -224),
        ];
        for (encoding, wire) in cases {
            assert_eq!(encoding.wire_value(), wire, "{encoding:?}");
            assert_eq!(u32::from(encoding), wire as u32, "{encoding:?}");
            assert_eq!(VncEncoding::from_wire(wire as u32), Some(encoding));
        }
    }

    #[test]
    fn tight_quality_and_compress_levels_map_to_their_pseudo_encodings() {
        assert_eq!(VncEncoding::TightJpegQuality(0).wire_value(), -32);
        assert_eq!(VncEncoding::TightJpegQuality(9).wire_value(), -23);
        assert_eq!(VncEncoding::TightCompressLevel(0).wire_value(), -256);
        assert_eq!(VncEncoding::TightCompressLevel(9).wire_value(), -247);
        // Out-of-range levels clamp instead of leaking into another encoding.
        assert_eq!(VncEncoding::TightJpegQuality(200).wire_value(), -23);
        assert_eq!(VncEncoding::TightCompressLevel(10).wire_value(), -247);
        // The server never sends rectangles in these pseudo-encodings.
        assert_eq!(VncEncoding::from_wire(-23i32 as u32), None);
        assert_eq!(VncEncoding::from_wire(-256i32 as u32), None);
    }
}

#[cfg(test)]
mod pixel_format_tests {
    use super::PixelFormat;

    // Ported from upstream 0.6.0 (1c07e2c), termiHub fork #3499.
    #[test]
    fn nonzero_wire_flags_are_normalised() {
        let bytes = [32, 24, 0, 255, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0];
        let format = PixelFormat::try_from(bytes).unwrap();
        assert_eq!(format.true_color_flag, 1);
        assert_eq!(format.big_endian_flag, 0);
        assert!(format.validate().is_ok());
        let mut big_endian = bytes;
        big_endian[2] = 255;
        assert_eq!(
            PixelFormat::try_from(big_endian).unwrap().big_endian_flag,
            1
        );
        let mut invalid_shift = bytes;
        invalid_shift[10] = 32;
        assert!(PixelFormat::try_from(invalid_shift)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn true_colour_masks_must_fit_without_overlap() {
        let mut format = PixelFormat::rgba();
        for shift in [8, 32, 255] {
            format.red_shift = shift;
            assert!(format.validate().is_err(), "red_shift {shift}");
        }
        format = PixelFormat::rgba();
        for max in [0, 254, u16::MAX] {
            format.red_max = max;
            assert!(format.validate().is_err(), "red_max {max}");
        }
        format = PixelFormat::rgba();
        format.depth = 0;
        assert!(format.validate().is_err());
        format.depth = 33;
        assert!(format.validate().is_err());

        format = PixelFormat::rgba();
        format.bits_per_pixel = 16;
        format.depth = 16;
        format.red_max = 31;
        format.green_max = 63;
        format.blue_max = 31;
        format.red_shift = 11;
        format.green_shift = 5;
        format.blue_shift = 0;
        assert!(format.validate().is_ok());
        format.bits_per_pixel = 8;
        format.depth = 8;
        format.red_max = 7;
        format.green_max = 7;
        format.blue_max = 3;
        format.red_shift = 5;
        format.green_shift = 2;
        assert!(format.validate().is_ok());
        assert!(PixelFormat::rgba().validate().is_ok());
        assert!(PixelFormat::bgra().validate().is_ok());
    }

    #[test]
    fn rgb565_is_a_valid_16bpp_true_colour_format() {
        let format = PixelFormat::rgb565();
        assert!(format.validate().is_ok());
        assert_eq!(format.bits_per_pixel, 16);
        assert_eq!(format.depth, 16);
        assert_eq!(format.big_endian_flag, 0);
        assert_eq!(format.true_color_flag, 1);
        assert_eq!(
            (format.red_max, format.green_max, format.blue_max),
            (31, 63, 31)
        );
        assert_eq!(
            (format.red_shift, format.green_shift, format.blue_shift),
            (11, 5, 0)
        );
    }

    #[test]
    fn colour_map_formats_skip_the_mask_checks() {
        let mut format = PixelFormat::rgba();
        format.bits_per_pixel = 8;
        format.depth = 8;
        format.true_color_flag = 0;
        format.red_max = 0;
        assert!(format.validate().is_ok());
    }
}
