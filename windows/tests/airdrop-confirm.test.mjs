import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a stale transfer marker from an earlier request never leaks into a decline", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "mochi-airdrop-"));
  chmodSync(runtime, 0o700);
  const base = join(runtime, "mochi-airdrop");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const marker = join(base, "transfer.json");
  writeFileSync(marker, JSON.stringify({ start: 1, offset: 0, directory: "/tmp" }), { mode: 0o600 });
  try {
    const child = spawn("bash", [script, "A nearby iPhone", "Photo.JPG"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, AIRDROP_CONFIRM_TIMEOUT: "1" },
    });
    const request = join(base, "active/request.json");
    for (let i = 0; i < 50 && !existsSync(request); i++) await delay(20);
    writeFileSync(join(base, "active/decision"), "decline", { mode: 0o600 });
    assert.equal(await new Promise(resolve => child.once("exit", resolve)), 1);
    // A decline writes no marker, and the previous run's must be gone, so the
    // island cannot keep reporting an older completed or failed transfer.
    assert.equal(existsSync(marker), false, "stale transfer marker must be cleared");
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test("a leftover decision from a killed hook is never inherited by a new request", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "mochi-airdrop-"));
  chmodSync(runtime, 0o700);
  const base = join(runtime, "mochi-airdrop/active");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  try {
    for (const stale of ["accept", "decline"]) {
      // A hook killed after answering leaves its decision behind. The next
      // request must neither inherit the answer nor be answered without a prompt.
      mkdirSync(base, { recursive: true, mode: 0o700 });
      writeFileSync(join(base, "decision"), stale, { mode: 0o600 });
      const child = spawn("bash", [script, "A nearby iPhone", "Photo.JPG"], {
        env: { ...process.env, XDG_RUNTIME_DIR: runtime, AIRDROP_CONFIRM_TIMEOUT: "1" },
      });
      const request = join(base, "request.json");
      for (let i = 0; i < 50 && !existsSync(request); i++) await delay(20);
      assert.ok(existsSync(request), "a new request must be raised even after a stale answer");
      // Nobody clicked, so it must still time out rather than settle instantly.
      assert.equal(await new Promise(resolve => child.once("exit", resolve)), 1);
    }
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test("every refusal records why, without recording sender or filename", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "mochi-airdrop-"));
  chmodSync(runtime, 0o700);
  try {
    await new Promise(resolve => {
      const child = spawn("bash", [script, "Secret iPhone Name", "SecretPhoto.JPG"], {
        env: { ...process.env, XDG_RUNTIME_DIR: runtime, AIRDROP_CONFIRM_TIMEOUT: "1" },
      });
      child.once("exit", resolve);
    });
    const log = readFileSync(join(runtime, "mochi-airdrop/hook.log"), "utf8");
    assert.match(log, /prompt raised/);
    assert.match(log, /nobody answered/);
    assert.doesNotMatch(log, /Secret iPhone Name|SecretPhoto\.JPG/);
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test("a leftover active directory from a killed hook does not decline every transfer", async () => {
  let result = null;
  const runtime = mkdtempSync(join(tmpdir(), "mochi-airdrop-"));
  chmodSync(runtime, 0o700);
  const stale = join(runtime, "mochi-airdrop/active");
  mkdirSync(stale, { recursive: true, mode: 0o700 });
  try {
    const child = spawn("bash", [script, "A nearby iPhone", "Photo.JPG"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, AIRDROP_CONFIRM_TIMEOUT: "1" },
    });
    const request = join(stale, "request.json");
    for (let i = 0; i < 50 && !existsSync(request); i++) await delay(20);
    assert.ok(existsSync(request), "a stale active dir must not block the new prompt");
    writeFileSync(join(stale, "decision"), "accept", { mode: 0o600 });
    result = await new Promise(resolve => child.once("exit", resolve));
  } finally { rmSync(runtime, { recursive: true, force: true }); }
  assert.equal(result, 0);
});
