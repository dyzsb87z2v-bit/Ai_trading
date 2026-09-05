/**
 * First-run setup: create .env with a real signing secret.
 *
 * The two values that MUST NOT have defaults are generated or demanded here:
 * a fallback AUTH_SECRET would mean every install signs sessions with the same
 * key, and a default password would mean every install has the same password.
 *
 * Re-running is safe: an existing .env is never overwritten.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

if (existsSync(envPath)) {
  console.log(".env already exists — leaving it untouched.");
  console.log("Delete it first if you want a fresh one.");
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error("Missing .env.example — cannot generate .env.");
  process.exit(1);
}

copyFileSync(examplePath, envPath);

const secret = randomBytes(48).toString("base64");
// A password is generated rather than left as "changeme": a placeholder
// password that works is a password nobody changes.
const password = randomBytes(12).toString("base64url");

let text = readFileSync(envPath, "utf8");
text = text.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`);
text = text.replace(/^APP_PASSWORD=.*$/m, `APP_PASSWORD=${password}`);

// Binance's public spot endpoints need no key and no account, so a hosted
// workspace can come up on real prices with nothing to configure. Opt-in via
// the environment so a plain local `npm run setup` keeps every provider off.
const enableBinance = /^(1|true|yes|on)$/i.test(process.env.SETUP_ENABLE_BINANCE ?? "");
if (enableBinance) {
  text = text.replace(/^BINANCE_ENABLED=.*$/m, "BINANCE_ENABLED=true");
}
writeFileSync(envPath, text);
// copyFileSync already created the file, so writeFileSync's `mode` would be
// ignored. Set it explicitly — this file holds the account password.
chmodSync(envPath, 0o600);

// Also drop the password in a file at the workspace root. In a browser IDE
// the creation log is easy to lose; a file you can open in the tree is not.
const passwordFile = join(root, "YOUR-PASSWORD.txt");
writeFileSync(
  passwordFile,
  `Sign-in password for the AI Trading Terminal\n\n    ${password}\n\n` +
    `Change it by editing APP_PASSWORD in .env, then restart the server.\n` +
    `This file is gitignored and is never committed.\n`,
  { mode: 0o600 }
);

console.log("Created .env with a freshly generated signing secret.\n");
console.log("  Your password:  " + password + "\n");
console.log("Also saved to YOUR-PASSWORD.txt. Both files are gitignored.");
if (enableBinance) {
  console.log("Binance public market data is ON — crypto symbols are real prices.");
  console.log("Use Binance spot pairs: BTCUSDT, ETHUSDT (not BTCUSD).");
}
console.log("Change APP_PASSWORD in .env to anything you prefer, then:\n");
console.log("  npm run dev     →  http://localhost:4310\n");
