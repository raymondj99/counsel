/**
 * Launch the Node website and Python tree mediator together.
 *
 * Usage:
 *   npm run launch -- case1
 *   MEDIATION_CASE=case2 npm run launch
 *   npm run launch -- --tree live/cases/case1/simulated_conversation_tree.json
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseName = process.env.MEDIATION_CASE;
const argv = process.argv.slice(2);

let mediatorArgs = ["live/serve.py"];
if (argv[0] === "--tree") {
  mediatorArgs.push("--tree", argv[1]);
} else if (argv[0]?.startsWith("--")) {
  mediatorArgs.push(...argv);
} else {
  const selectedCase = argv[0] || caseName || "case1";
  mediatorArgs.push("--case", selectedCase);
}

const children = [];

function spawnProc(command, args, label) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`${label} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const mediator = spawnProc("python", mediatorArgs, "Mediator");
const server = spawnProc("node", ["server.js"], "Server");

server.on("exit", (code) => shutdown());
mediator.on("exit", (code) => {
  if (code && code !== 0) shutdown();
});

if (!existsSync(path.join(root, ".env"))) {
  console.warn("Warning: .env not found. Copy config.env.example to .env and add API keys.");
}

console.log(`Launching with: python ${mediatorArgs.join(" ")}`);
