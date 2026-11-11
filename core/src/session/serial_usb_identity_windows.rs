//! The USB identity of a Windows COM port, read from the device tree (#5394).
//!
//! The COM port's device node is found with SetupAPI (the `Ports` and `Modem`
//! setup classes, present devices only) by its `PortName` registry value. From
//! there the device tree is walked up with CfgMgr until a node whose instance id
//! is a whole USB device (`USB\VID_xxxx&PID_xxxx\<serial>`), which
//! [`super::usb_identity_from_windows_device_id`] parses. Composite-device
//! interfaces (`…&MI_00`) and vendor buses (`FTDIBUS\…`) sit below it and are
//! skipped. Nothing here opens a port: it only reads the device tree.

use windows_sys::core::GUID;
use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_Device_IDW, CM_Get_Parent, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
    SetupDiGetClassDevsW, SetupDiOpenDevRegKey, CR_SUCCESS, DICS_FLAG_GLOBAL, DIGCF_PRESENT,
    DIREG_DEV, GUID_DEVCLASS_MODEM, GUID_DEVCLASS_PORTS, HDEVINFO, MAX_DEVICE_ID_LEN,
    SP_DEVINFO_DATA,
};
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Registry::{RegCloseKey, RegQueryValueExW, HKEY, KEY_READ, REG_SZ};

use super::{usb_identity_from_windows_device_id, SerialDeviceIdentity};

/// How far up the device tree to look for the USB device. A COM port is at
/// most a couple of levels below it (interface, vendor bus); the bound only
/// guards against a malformed tree.
const MAX_ANCESTORS: usize = 8;

/// A SetupAPI device information set, destroyed on drop.
struct DevInfoSet(HDEVINFO);

impl Drop for DevInfoSet {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a valid set returned by SetupDiGetClassDevsW.
        unsafe {
            SetupDiDestroyDeviceInfoList(self.0);
        }
    }
}

/// The USB identity of the device behind COM port `port` (e.g. `COM3`).
pub(super) fn usb_identity(port: &str) -> Option<SerialDeviceIdentity> {
    let mut dev_inst = [GUID_DEVCLASS_PORTS, GUID_DEVCLASS_MODEM]
        .iter()
        .find_map(|class| find_port_dev_inst(class, port))?;
    for _ in 0..MAX_ANCESTORS {
        if let Some(identity) = usb_identity_from_windows_device_id(&device_id(dev_inst)?) {
            return Some(identity);
        }
        let mut parent = 0u32;
        // SAFETY: `parent` is a valid out-pointer and `dev_inst` a devnode
        // handle obtained from SetupAPI / CM_Get_Parent.
        if unsafe { CM_Get_Parent(&mut parent, dev_inst, 0) } != CR_SUCCESS {
            return None;
        }
        dev_inst = parent;
    }
    None
}

/// The devnode of the present device in setup class `class` whose `PortName`
/// is `port` (compared case-insensitively, like Windows does).
fn find_port_dev_inst(class: &GUID, port: &str) -> Option<u32> {
    // SAFETY: `class` points to a valid GUID; no enumerator or window is passed.
    let set = unsafe {
        SetupDiGetClassDevsW(class, std::ptr::null(), std::ptr::null_mut(), DIGCF_PRESENT)
    };
    if set == INVALID_HANDLE_VALUE as HDEVINFO {
        return None;
    }
    let set = DevInfoSet(set);
    for index in 0.. {
        let mut data = SP_DEVINFO_DATA {
            cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
            ClassGuid: GUID::from_u128(0),
            DevInst: 0,
            Reserved: 0,
        };
        // SAFETY: `set.0` is a live set and `data` has `cbSize` set.
        if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut data) } == 0 {
            return None;
        }
        // SAFETY: `set.0` and `data` describe a device of that set.
        let key =
            unsafe { SetupDiOpenDevRegKey(set.0, &data, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ) };
        if key == INVALID_HANDLE_VALUE as HKEY {
            continue;
        }
        let name = read_registry_string(key, "PortName");
        // SAFETY: `key` is an open key returned above, closed exactly once.
        unsafe {
            RegCloseKey(key);
        }
        if name.is_some_and(|n| n.eq_ignore_ascii_case(port)) {
            return Some(data.DevInst);
        }
    }
    None
}

/// A `REG_SZ` value of an open registry key.
fn read_registry_string(key: HKEY, value: &str) -> Option<String> {
    let name: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut kind = 0u32;
    let mut buf = [0u16; 256];
    let mut size = std::mem::size_of_val(&buf) as u32;
    // SAFETY: `name` is NUL-terminated; `buf` holds `size` bytes.
    let status = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 || kind != REG_SZ {
        return None;
    }
    Some(utf16_until_nul(&buf[..(size as usize / 2).min(buf.len())]))
}

/// The device instance id of devnode `dev_inst`.
fn device_id(dev_inst: u32) -> Option<String> {
    let mut buf = [0u16; MAX_DEVICE_ID_LEN as usize + 1];
    // SAFETY: `buf` holds `buf.len()` UTF-16 units, the length passed.
    let status = unsafe { CM_Get_Device_IDW(dev_inst, buf.as_mut_ptr(), buf.len() as u32, 0) };
    (status == CR_SUCCESS).then(|| utf16_until_nul(&buf))
}

fn utf16_until_nul(units: &[u16]) -> String {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}
