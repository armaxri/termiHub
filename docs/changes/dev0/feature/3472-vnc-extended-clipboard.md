### Added

- VNC sessions now use the RFB Extended Clipboard when the server supports it
  (TigerVNC, RealVNC, libvncserver): clipboard text in any language — including
  characters beyond Latin-1 such as `日本語` or emoji — round-trips losslessly,
  and on servers that offer bitmap clipboard data (`dib`) the clipboard panel's
  image actions work for VNC just as for RDP. Servers without the extension keep
  the existing text clipboard (#3472).
