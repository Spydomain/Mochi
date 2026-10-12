import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/cleanup-opencode-sessions.sh", import.meta.url));

test("cleanup deletes only Mochi sessions older than 30 days", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mochi-cleanup-"));
  const bin = join(dir, "bin");
  const log = join(dir, "deleted.txt");
  try {
    await mkdir(bin);
    const fake = join(bin, "opencode");
    await writeFile(fake, `#!/usr/bin/env bash
if [[ "$1 $2" == "session list" ]]; then
  printf '%s' "$MOCHI_MOCK_SESSIONS"
elif [[ "$1 $2" == "session delete" ]]; then
  printf '%s\\n' "$3" >> "$MOCHI_DELETE_LOG"
else
  exit 1
fi
`);
    await chmod(fake, 0o755);
    const now = Date.now();
    const sessions = [
      { id: "ses_old_mochi", title: "Mochi chat", updated: now - 35 * 86400_000 },
      { id: "ses_new_mochi", title: "Mochi chat", updated: now - 2 * 86400_000 },
      { id: "ses_unrelated", title: "Research", updated: now - 50 * 86400_000 },
    ];
    const env = {
      ...process.env,
      HOME: dir,
      PATH: `${bin}:${process.env.PATH}`,
      MOCHI_MOCK_SESSIONS: JSON.stringify(sessions),
      MOCHI_DELETE_LOG: log,
    };
    const dry = spawnSync("bash", [script, "--dry-run"], { env, encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /ses_old_mochi/);
    assert.doesNotMatch(dry.stdout, /ses_new_mochi|ses_unrelated/);
    const run = spawnSync("bash", [script], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(await readFile(log, "utf8"), "ses_old_mochi\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
