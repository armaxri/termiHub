### Added

- Plugin packaging now refuses a native plugin whose manifest `apiVersion` does
  not match the ABI its library exports, with an error naming both versions,
  instead of building a package termiHub would refuse on load. The packager
  reads a marker embedded by the new
  `termihub_plugin_api::export_plugin_abi_version!()` macro (the library is
  never loaded), so it works for every target platform; a library without the
  marker is packaged with a warning (#3372).
