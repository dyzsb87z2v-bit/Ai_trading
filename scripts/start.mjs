/**
 * Start the dev server, unless one is already listening.
 *
 * The dev container runs this every time the workspace is attached, and a
 * reconnect must not fail with EADDRINUSE or silently start a second server
 * against the same SQLite file.
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 4310;

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readPassword() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return null;
  const match = /^APP_PASSWORD=(.*)$/m.exec(readFileSync(envPath, "utf8"));
  return match ? match[1].trim() : null;
}

const password = readPassword();
if (password) {
  console.log("\n────────────────────────────────────────");
  console.log("  Sign in with this password:");
  console.log("  " + password);
  console.log("────────────────────────────────────────\n");
} else {
  console.log("\nNo .env found. Run `npm run setup` first.\n");
}

if (await portInUse(PORT)) {
  console.log(`The terminal is already running on port ${PORT}.`);
  console.log("Open the forwarded port to use it.\n");
  process.exit(0);
}

const child = spawn("npx", ["next", "dev", "--port", String(PORT)], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
