import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const script = resolve("scripts/mochi-airdrop-confirm.sh");

async function attempt(answer) {
  const runtime = mkdtempSync(join(tmpdir(), "mochi-airdrop-"));
  chmodSync(runtime, 0o700);
  try {
    const child = spawn("bash", [script, "A nearby iPhone", "Photo.JPG"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, AIRDROP_CONFIRM_TIMEOUT: "1" },
    });
    const request = join(runtime, "mochi-airdrop/active/request.json");
    for (let i = 0; i < 50 && !existsSync(request); i++) await delay(20);
    assert.ok(existsSync(request), "request reached the private runtime directory");
    const data = JSON.parse(readFileSync(request, "utf8"));
    assert.equal(data.sender, "A nearby iPhone");
    assert.equal(data.detail, "Photo.JPG");
    if (answer !== null) writeFileSync(join(runtime, "mochi-airdrop/active/decision"), answer, { mode: 0o600 });
    const result = await new Promise(resolve => child.once("exit", resolve));
    if (answer === "accept") {
      const transfer = JSON.parse(readFileSync(join(runtime, "mochi-airdrop/transfer.json"), "utf8"));
      assert.equal(transfer.directory, process.cwd());
      assert.ok(transfer.start > 0);
      assert.equal(transfer.offset, 0);
    }
    assert.equal(existsSync(join(runtime, "mochi-airdrop/active")), false);
    return result;
  } finally { rmSync(runtime, { recursive: true, force: true }); }
}

test("AirDrop island consent accepts only an explicit yes, declines other answers and times out", async () => {
  assert.equal(await attempt("accept"), 0);
  assert.equal(await attempt("decline"), 1);
  assert.equal(await attempt("yes"), 1);
  assert.equal(await attempt(null), 1);
});
