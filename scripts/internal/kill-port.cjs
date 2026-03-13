#!/usr/bin/env node
// Kill any process listening on the given port, then verify it is free.
// Usage: node scripts/kill-port.cjs [port]
const { execSync } = require("child_process");
const net = require("net");

const port = parseInt(process.argv[2] || "1420", 10);

/** Try to bind to the port — resolves true if the port is free. */
function isPortFree() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find PIDs listening on the port and kill them. */
function findAndKill() {
  if (process.platform === "win32") {
    let out;
    try {
      // Pipe through findstr for speed — avoids parsing the full netstat dump
      out = execSync(`netstat -ano -p TCP | findstr ":${port} "`, {
        encoding: "utf8",
        timeout: 10000,
      });
    } catch {
      return; // No matches or command failed
    }
    const pids = new Set();
    for (const line of out.split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[0] !== "TCP") continue;
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
  } else {
    try {
      const pids = execSync(`lsof -ti :${port}`, { encoding: "utf8" }).trim();
      if (!pids) return;
      for (const pid of pids.split("\n")) {
        console.log(`Port ${port} in use (PID ${pid}), killing...`);
        try {
          process.kill(parseInt(pid, 10));
        } catch {}
      }
    } catch {
      return;
    }
  }
}

async function main() {
  // Fast check — skip everything if port is already free
  if (await isPortFree()) return;

  findAndKill();

  // Poll until the port is free (200ms intervals, up to 5s)
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (await isPortFree()) return;
  }
  console.error(`Warning: port ${port} is still occupied`);
}

main().catch((err) => console.error("Warning:", err.message));
