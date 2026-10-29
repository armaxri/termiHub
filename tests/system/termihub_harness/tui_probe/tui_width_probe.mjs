// Full-screen TUI width probe (#5065).
//
// Draws like a full-screen TUI (Claude Code, Ink): alternate screen, every row
// positioned with CUP and filled to the width the program reads from its
// terminal (`process.stdout.columns`), redrawn on every resize. Row 1 is a
// header `<tag>:<cols>x<rows>:....|`; each further row (but the last, so the
// screen never scrolls) is a ruler `1234567890…|` of exactly `cols` cells.
// When the program's width matches the visible grid, every row ends in `|` at
// the pane's last column. Typing `q` leaves the alternate screen and exits.
const tag = process.argv[2] ?? "TUIW";
const out = process.stdout;

function ruler(cols) {
  let line = "";
  for (let i = 1; i < cols; i++) line += String(i % 10);
  return `${line}|`;
}

function header(cols, rows) {
  const head = `${tag}:${cols}x${rows}:`;
  return `${head.padEnd(cols - 1, ".").slice(0, cols - 1)}|`;
}

let draws = 0;
function draw() {
  const cols = out.columns;
  const rows = out.rows;
  draws += 1;
  let frame = "\x1b[H\x1b[2J";
  frame += `\x1b[1;1H${header(cols, rows)}`;
  for (let row = 2; row < rows; row++) frame += `\x1b[${row};1H${ruler(cols)}`;
  out.write(frame);
}

out.write("\x1b[?1049h\x1b[?25l");
draw();
out.on("resize", draw);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  if (!data.includes(0x71)) return;
  out.write("\x1b[?25h\x1b[?1049l");
  out.write(`${tag}:done:${draws}\n`);
  process.exit(0);
});
