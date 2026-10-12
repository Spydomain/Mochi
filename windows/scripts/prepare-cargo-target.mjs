import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Tauri's generated permission metadata can embed an absolute target path.
// When a checkout is moved, Cargo may otherwise reuse stale metadata pointing
// at the old directory. Keep a private marker beside the generated cache and
// clear that cache once if its workspace changes.
const workspace = realpathSync(process.cwd());
const targetDir = resolve("target");
const marker = join(targetDir, ".mochi-workspace");
const hasTarget = existsSync(targetDir);
const recordedWorkspace = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
const hasCargoOutput = hasTarget && readdirSync(targetDir).some((entry) => entry === "debug" || entry === "release");

if ((recordedWorkspace && recordedWorkspace !== workspace) || (!recordedWorkspace && hasCargoOutput)) {
  rmSync(targetDir, { recursive: true, force: true });
  console.log("Removed stale Cargo build cache after a Mochi checkout move.");
}

mkdirSync(targetDir, { recursive: true });
writeFileSync(marker, `${workspace}\n`);
