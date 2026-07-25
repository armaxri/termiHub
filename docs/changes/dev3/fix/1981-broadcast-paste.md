### Fixed

- **Broadcast input** now includes **keyboard paste**. Pasting with
  Cmd/Ctrl+Shift+V into a broadcast source previously reached only the source
  terminal (typed input and context-menu paste already broadcast); it now fans
  out to every connected broadcast target, each with its own bracketed-paste
  handling. (#1981)
