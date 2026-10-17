use bitflags::bitflags;
use ironrdp_core::{Decode, DecodeResult, Encode, EncodeResult, ReadCursor, WriteCursor, ensure_fixed_part_size};

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct MultiTransportChannelData {
    pub flags: MultiTransportFlags,
}

impl MultiTransportChannelData {
    const NAME: &'static str = "MultiTransportChannelData";

    const FIXED_PART_SIZE: usize = 4 /* flags */;
}

impl Encode for MultiTransportChannelData {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_fixed_part_size!(in: dst);

        dst.write_u32(self.flags.bits());

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
    }
}

impl<'de> Decode<'de> for MultiTransportChannelData {
    fn decode(src: &mut ReadCursor<'de>) -> DecodeResult<Self> {
        ensure_fixed_part_size!(in: src);

        // termiHub fork (#4461): ported from upstream IronRDP e8a75797 (#1844).
        // [MS-RDPBCGR] 2.2.1.3.8's transportFlags list has grown before
        // (UDP_PREFERRED and SOFTSYNC_TCP_TO_UDP are later additions), and
        // 3.3.5.3.3 never asks the receiver to validate it; retain unknown
        // bits rather than failing the GCC exchange.
        let flags = MultiTransportFlags::from_bits_retain(src.read_u32());

        Ok(Self { flags })
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
    #[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
    pub struct MultiTransportFlags: u32 {
        const TRANSPORT_TYPE_UDP_FECR = 0x01;
        const TRANSPORT_TYPE_UDP_FECL = 0x04;
        const TRANSPORT_TYPE_UDP_PREFERRED = 0x100;
        const SOFT_SYNC_TCP_TO_UDP = 0x200;
    }
}

#[cfg(test)]
mod tests {
    use ironrdp_core::{decode, encode_vec};

    use super::*;

    // termiHub fork (#4461): ported from upstream IronRDP e8a75797 (#1844).
    #[test]
    fn unknown_transport_flag_bits_are_retained() {
        // TRANSPORT_TYPE_UDP_FECR plus an undefined bit (0x8000).
        let encoded = [0x01, 0x80, 0x00, 0x00];

        let decoded: MultiTransportChannelData = decode(encoded.as_ref()).expect("unknown bits are retained");

        assert!(decoded.flags.contains(MultiTransportFlags::TRANSPORT_TYPE_UDP_FECR));
        assert_eq!(decoded.flags.bits(), 0x8001);
        assert_eq!(encode_vec(&decoded).unwrap(), encoded);
    }
}
