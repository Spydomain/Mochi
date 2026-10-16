import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Compile in memory: tests need neither Worker tooling nor real signing keys.
const source = ts.transpileModule(
  readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

const encoder = new TextEncoder();
const failure = "synthetic-private-marker: request details must never be returned";
const genericError = { reason: "RelayDeliveryFailed" };

function valid() {
  return {
    token: "a".repeat(64), env: "development", event: "update",
    state: { pillId: "test", agent: "Test", color: "#ffffff", state: "working",
      statusText: "working", tone: "working", stepIndex: 0, stepCount: 1, others: 0 },
  };
}

function fixture() {
  let now = 1_800_000_000_000;
  const calls = { imports: [], signatures: [], apns: [] };
  const hooks = {
    importKey: async () => ({}),
    sign: async () => new Uint8Array(64).fill(calls.signatures.length).buffer,
    fetch: async () => new Response(null, { status: 200 }),
  };
  const context = {
    exports: {}, Request, Response, URL, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
    Date: class extends Date { static now() { return now; } },
    crypto: { subtle: {
      async importKey(...args) { calls.imports.push(args); return hooks.importKey(...args); },
      async sign(...args) { calls.signatures.push(args); return hooks.sign(...args); },
    } },
    fetch: async (...args) => { calls.apns.push(args); return hooks.fetch(...args); },
  };
  vm.runInNewContext(source, context, { filename: "relay-under-test.cjs" });
  // These bytes are deliberately not a private key. Crypto is always mocked.
  const env = { APNS_KEY: "AA==", APNS_KEY_ID: "synthetic-key",
    APNS_TEAM_ID: "synthetic-team", APNS_TOPIC: "test.push-type.liveactivity" };
  const invoke = (request, bindings = env) => context.exports.default.fetch(request, bindings);
  const send = (body = valid(), bindings = env) => invoke(new Request(
    "https://relay.invalid/v1/live-activity", { method: "POST", body: JSON.stringify(body) },
  ), bindings);
  return { calls, hooks, env, invoke, send, setNow(value) { now = value; } };
}

function streamed(chunks, headers = {}, onCancel = () => {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel: onCancel,
  }, { highWaterMark: 0 });
  return {
    request: new Request("https://relay.invalid/v1/live-activity", {
      method: "POST", body, duplex: "half", headers,
    }),
    reads: () => index,
  };
}

async function assertDeliveryError(response, upstreamStatus = null) {
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("x-apns-status"), upstreamStatus);
  assert.deepEqual(await response.json(), genericError);
}

function jwt(f, index = f.calls.apns.length - 1) {
  return f.calls.apns[index][1].headers.authorization.slice("bearer ".length);
}

test("health and unknown routes do not sign or contact APNs", async () => {
  const f = fixture();
  assert.equal(await (await f.invoke(new Request("https://relay.invalid/"))).text(), "Mochi relay");
  assert.equal((await f.invoke(new Request("https://relay.invalid/unknown"))).status, 404);
  assert.equal(f.calls.imports.length, 0);
  assert.equal(f.calls.apns.length, 0);
});

test("valid events preserve payload, priority, routing and optional fields", async (t) => {
  for (const [event, urgent, priority] of [
    ["start", undefined, "10"], ["update", undefined, "5"],
    ["update", false, "5"], ["update", true, "10"], ["end", false, "10"],
  ]) {
    await t.test(`${event}, urgent=${urgent}`, async () => {
      const f = fixture();
      const body = { ...valid(), event, env: "production", urgent, dismissAfter: 30 };
      body.state.since = 1_700_000_000;
      body.state.approval = "b".repeat(64);
      body.state.extra = "do not forward";
      assert.equal(await (await f.send(body)).text(), "ok");
      const [url, init] = f.calls.apns[0];
      const { aps } = JSON.parse(init.body);
      assert.equal(url, `https://api.push.apple.com/3/device/${body.token}`);
      assert.equal(init.headers["apns-priority"], priority);
      assert.equal(init.headers["apns-topic"], f.env.APNS_TOPIC);
      assert.equal(init.headers["apns-push-type"], "liveactivity");
      assert.equal(aps.event, event);
      assert.equal(aps.timestamp, 1_800_000_000);
      assert.equal(aps["stale-date"], 1_800_000_900);
      const { extra, ...expectedState } = body.state;
      assert.deepEqual(aps["content-state"], expectedState);
      assert.equal(Boolean(aps.alert), event === "start" || urgent === true);
      if (event === "start") {
        assert.equal(aps["attributes-type"], "MochiActivityAttributes");
        assert.deepEqual(aps.attributes, {});
      }
      if (event === "end") assert.equal(aps["dismissal-date"], aps.timestamp + 30);
    });
  }
});

test("streamed bodies over 4096 bytes are cancelled before JSON parsing or signing", async (t) => {
  for (const headers of [{}, { "content-length": "1" }]) {
    await t.test(JSON.stringify(headers), async () => {
      const f = fixture();
      let cancelled = false;
      const bytes = encoder.encode(JSON.stringify({ ...valid(), unused: "x".repeat(5000) }));
      const input = streamed([
        bytes.subarray(0, 2048), bytes.subarray(2048, 4096),
        bytes.subarray(4096, 4097), bytes.subarray(4097),
      ], headers, () => { cancelled = true; });
      assert.equal(input.request.headers.get("content-length"), headers["content-length"] ?? null);
      const response = await f.invoke(input.request);
      assert.equal(response.status, 413);
      assert.equal(await response.text(), "too large");
      assert.ok(cancelled);
      assert.equal(input.reads(), 3, "must stop at the first overflowing chunk");
      assert.equal(f.calls.imports.length, 0);
      assert.equal(f.calls.apns.length, 0);
    });
  }
});

test("oversized single chunks do not wait for stalled or rejecting cancellation hooks", async (t) => {
  for (const cancel of [() => new Promise(() => {}), () => Promise.reject(new Error(failure))]) {
    await t.test(cancel.toString(), { timeout: 1000 }, async () => {
      const f = fixture();
      const input = streamed([new Uint8Array(8192)], {}, cancel);
      assert.equal((await f.invoke(input.request)).status, 413);
    });
  }
});

test("declared oversized bodies are cancelled without reading", async () => {
  const f = fixture();
  let cancelled = false;
  const input = streamed([encoder.encode(JSON.stringify(valid()))],
    { "content-length": "4097" }, () => { cancelled = true; });
  assert.equal((await f.invoke(input.request)).status, 413);
  assert.ok(cancelled);
  assert.equal(input.reads(), 0);
});

test("exactly 4096 bytes are accepted, including UTF-8 split between chunks", async () => {
  const f = fixture();
  const body = { ...valid(), unused: "é" };
  let bytes = encoder.encode(JSON.stringify(body));
  const split = bytes.indexOf(0xc3) + 1;
  bytes = encoder.encode(JSON.stringify(body) + " ".repeat(4096 - bytes.byteLength));
  const input = streamed([bytes.subarray(0, split), bytes.subarray(split)]);
  assert.equal((await f.invoke(input.request)).status, 200);
  assert.equal(f.calls.apns.length, 1);
});

test("size counts UTF-8 bytes rather than JavaScript characters", async () => {
  const f = fixture();
  const json = JSON.stringify({ ...valid(), unused: "é".repeat(2000) });
  assert.ok(json.length < 4096);
  assert.ok(encoder.encode(json).byteLength > 4096);
  assert.equal((await f.invoke(streamed([encoder.encode(json)]).request)).status, 413);
});

test("invalid urgent types are rejected without signing", async (t) => {
  for (const urgent of ["false", 0, 1, null, {}, []]) {
    await t.test(JSON.stringify(urgent), async () => {
      const f = fixture();
      const response = await f.send({ ...valid(), urgent });
      assert.equal(response.status, 400);
      assert.equal(await response.text(), "urgent");
      assert.equal(f.calls.imports.length, 0);
      assert.equal(f.calls.apns.length, 0);
    });
  }
});

test("malformed JSON, invalid state and request read failures remain controlled 400s", async () => {
  const f = fixture();
  assert.equal((await f.invoke(streamed([encoder.encode("{")]).request)).status, 400);
  assert.equal((await f.send(null)).status, 400);
  const body = valid();
  body.state.others = -1;
  assert.equal((await f.send(body)).status, 400);
  const request = new Request("https://relay.invalid/v1/live-activity", {
    method: "POST", duplex: "half", body: new ReadableStream({
      start(controller) { controller.error(new Error(failure)); },
    }),
  });
  const response = await f.invoke(request);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "bad json");
  assert.equal(f.calls.imports.length, 0);
});

test("key import and signing failures are sanitized 502s and do not poison the cache", async (t) => {
  for (const operation of ["importKey", "sign"]) {
    await t.test(operation, async () => {
      const f = fixture();
      const original = f.hooks[operation];
      f.hooks[operation] = async () => { throw new Error(failure); };
      await assertDeliveryError(await f.send());
      assert.equal(f.calls.apns.length, 0);
      f.hooks[operation] = original;
      assert.equal((await f.send()).status, 200);
      assert.equal(f.calls.imports.length, 2);
    });
  }
});

test("fetch failures are sanitized 502s", async () => {
  const f = fixture();
  f.hooks.fetch = async () => { throw new Error(failure); };
  await assertDeliveryError(await f.send());
});

test("upstream read failures are sanitized 502s with upstream status", async (t) => {
  for (const status of [500, 410]) {
    await t.test(String(status), async () => {
      const f = fixture();
      f.hooks.fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.error(new Error(failure)); },
      }), { status });
      await assertDeliveryError(await f.send(), String(status));
    });
  }
});

test("oversized upstream errors are bounded and cancelled", async () => {
  const f = fixture();
  let cancelled = false;
  f.hooks.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4097)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 503 });
  await assertDeliveryError(await f.send(), "503");
  assert.ok(cancelled);
});

test("recognized APNs reasons retain the wire contract but extra data is stripped", async (t) => {
  for (const [status, reason] of [[400, "BadDeviceToken"], [410, "Unregistered"], [403, "InvalidProviderToken"]]) {
    await t.test(reason, async () => {
      const f = fixture();
      f.hooks.fetch = async () => new Response(JSON.stringify({ reason, extra: failure }), { status });
      const response = await f.send();
      assert.equal(response.status, status === 410 ? 410 : 502);
      assert.equal(response.headers.get("x-apns-status"), String(status));
      assert.deepEqual(await response.json(), { reason });
    });
  }
});

test("unexpected upstream bodies and reason strings never leak", async (t) => {
  for (const body of [failure, "", "null", JSON.stringify({ reason: failure }), JSON.stringify({ reason: "UnknownSyntheticReason" })]) {
    await t.test(JSON.stringify(body), async () => {
      const f = fixture();
      f.hooks.fetch = async () => new Response(body, { status: 500 });
      await assertDeliveryError(await f.send(), "500");
    });
  }
});

test("cache reuses matching credentials and invalidates for team, key ID or key material changes", async (t) => {
  for (const change of [{ APNS_TEAM_ID: "other-synthetic-team" },
    { APNS_KEY_ID: "other-synthetic-id" }, { APNS_KEY: "AQ==" }]) {
    await t.test(Object.keys(change)[0], async () => {
      const f = fixture();
      await f.send();
      await f.send();
      assert.equal(f.calls.signatures.length, 1);
      assert.equal(jwt(f, 0), jwt(f, 1));
      const bindings = { ...f.env, ...change };
      await f.send(valid(), bindings);
      assert.equal(f.calls.signatures.length, 2);
      assert.notEqual(jwt(f, 1), jwt(f, 2));
      const [header, claims] = jwt(f).split(".").map(part => Buffer.from(part, "base64url").toString());
      assert.equal(JSON.parse(header).kid, bindings.APNS_KEY_ID);
      assert.equal(JSON.parse(claims).iss, bindings.APNS_TEAM_ID);
      assert.deepEqual([...new Uint8Array(f.calls.imports[1][1])], [...Buffer.from(bindings.APNS_KEY, "base64")]);
    });
  }
});

test("cache refreshes after 50 minutes and after a backward clock jump", async (t) => {
  for (const nextTime of [1_800_003_000_000, 1_799_999_999_000]) {
    await t.test(String(nextTime), async () => {
      const f = fixture();
      await f.send();
      f.setNow(nextTime);
      await f.send();
      assert.equal(f.calls.signatures.length, 2);
    });
  }
});

test("concurrent cold requests coalesce their in-flight signing", async () => {
  const f = fixture();
  let release;
  let started;
  const signingStarted = new Promise(resolve => { started = resolve; });
  f.hooks.sign = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const responses = Array.from({ length: 8 }, () => f.send());
  await signingStarted;
  assert.equal(f.calls.apns.length, 0);
  release(new Uint8Array(64).buffer);
  assert.ok((await Promise.all(responses)).every(response => response.status === 200));
  assert.equal(f.calls.imports.length, 1);
  assert.equal(f.calls.signatures.length, 1);
  assert.equal(new Set(f.calls.apns.map((_, index) => jwt(f, index))).size, 1);
});

test("failure of old in-flight credentials cannot clear a newer cache entry", async () => {
  const f = fixture();
  let rejectOld;
  let started;
  const signingStarted = new Promise(resolve => { started = resolve; });
  f.hooks.sign = async () => {
    if (f.calls.signatures.length === 1) {
      started();
      return new Promise((_, reject) => { rejectOld = reject; });
    }
    return new Uint8Array(64).buffer;
  };
  const old = f.send();
  await signingStarted;
  const newer = { ...f.env, APNS_TEAM_ID: "newer-synthetic-team" };
  assert.equal((await f.send(valid(), newer)).status, 200);
  rejectOld(new Error(failure));
  await assertDeliveryError(await old);
  assert.equal((await f.send(valid(), newer)).status, 200);
  assert.equal(f.calls.signatures.length, 2);
});
