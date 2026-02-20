#!/usr/bin/env node
// Kill any process listening on the given port.
// Usage: node scripts/kill-port.js [port]
const { execSync } = require("child_process");
const port = process.argv[2] || "1420";

function killOnWindows() {
  const out = execSync("netstat -ano", { encoding: "utf8" });
  const pids = new Set();
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    // cols: [Proto, LocalAddr, ForeignAddr, State, PID]
    if (cols[0] !== "TCP" && cols[0] !== "UDP") continue;
    if (!cols[1] || !cols[1].endsWith(":" + port)) continue;
    const pid = cols[cols.length - 1];
    if (pid && pid !== "0") pids.add(pid);
  }
  for (const pid of pids) {
    console.log(`Port ${port} in use (PID ${pid}), killing...`);
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {}
  }
  if (pids.size > 0) {
    // Brief wait for the OS to release the port
    execSync("ping -n 3 127.0.0.1", { stdio: "ignore" });
  }
}

function killOnUnix() {
  let pids;
  try {
    pids = execSync(`lsof -ti :${port}`, { encoding: "utf8" }).trim();
  } catch {
    return; // No process found
  }
  if (!pids) return;
  for (const pid of pids.split("\n")) {
    console.log(`Port ${port} in use (PID ${pid}), killing...`);
    try {
      process.kill(parseInt(pid, 10));
    } catch {}
  }
}

try {
  if (process.platform === "win32") {
    killOnWindows();
  } else {
    killOnUnix();
  }
} catch (err) {
  // Non-fatal — proceed with dev server startup regardless
  console.error("Warning: could not check port:", err.message);
}
