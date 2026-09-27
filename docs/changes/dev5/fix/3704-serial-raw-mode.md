### Fixed

- Serial: ports are now always switched to raw mode when opened. A device left in the
  default "cooked" terminal mode (line-buffered input, local echo, CR/LF translation)
  previously kept that mode, so input only arrived after a newline, typed characters
  were echoed back to the device and line endings were rewritten (#3704).
