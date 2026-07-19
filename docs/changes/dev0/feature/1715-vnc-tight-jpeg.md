### Added

- VNC: the backend now negotiates the **Tight** encoding — the most
  bandwidth-efficient common RFB encoding — including its **JPEG** sub-rects. A
  Tight-encoding server renders correctly through the shared remote-desktop
  canvas: JPEG rectangles are decoded to RGBA and folded into the shared
  dirty-rect frame stream alongside the existing Raw / ZRLE / CopyRect
  encodings. Tight is advertised ahead of ZRLE under the compressed encoding
  preference and omitted under the Raw preference (#1715).
