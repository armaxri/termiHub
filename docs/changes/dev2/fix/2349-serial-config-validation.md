### Fixed

- Serial connections now reject an invalid port configuration instead of
  silently falling back to defaults. An out-of-range data-bits or stop-bits
  value, an unrecognized parity or flow-control value, or a zero baud rate is
  reported as a clear configuration error rather than quietly opening the port
  at the wrong framing (which would corrupt every byte to the attached
  hardware). Standard connections created through the editor are unaffected;
  the change hardens configs that bypass the editor, such as imported or
  hand-edited config files and workspace restore.
