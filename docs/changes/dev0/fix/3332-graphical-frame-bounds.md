### Fixed

- Remote desktop (VNC/RDP): a server advertising an absurd desktop size or sending
  malformed framebuffer updates can no longer drive an unbounded allocation or paint
  outside the canvas. Every backend's frames now pass one shared bound (8192 px per
  axis, dirty rects must lie inside the framebuffer and carry exactly `w*h*4` bytes);
  invalid frames are dropped, and a session that keeps sending them is disconnected
  with an explanatory message. The RDP helper also refuses oversized desktop sizes
  before allocating (#3332).
