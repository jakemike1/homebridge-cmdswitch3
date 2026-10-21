"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtempSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { CommandRunner } = require("../command-runner");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const node = (script) => `${quote(process.execPath)} -e ${quote(script)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function runner(t, options) {
  const r = new CommandRunner(options);
  t.after(() => r.dispose());
  return r;
}
function running(pid) {
  try {
    process.kill(pid, 0);
    // A killed Linux grandchild can briefly be a zombie awaiting PID 1 reaping.
    if (
      process.platform === "linux" &&
      readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z ")
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

test("actual shell keeps exit status and ignores harmless stderr", async (t) => {
  const r = runner(t);
  assert.deepEqual(await r.run("printf warning >&2; exit 0", 1000).promise, {
    code: 0,
  });
  assert.deepEqual(await r.run("exit 7", 1000).promise, { code: 7 });
});

test("invalid command settles as Error without spawning", async (t) => {
  const r = runner(t);
  await assert.rejects(r.run(undefined, 100).promise, {
    code: "INVALID_COMMAND",
  });
  assert.equal(r.active.size, 0);
});

test("stdout and stderr stream errors reject safely, stop the process and omit raw error details", async (t) => {
  const r = runner(t);
  for (const channel of ["stdout", "stderr"]) {
    const job = r.run(node("setInterval(()=>{},1000)"), 2000);
    const rejected = assert.rejects(job.promise, (error) => {
      assert.equal(error.code, "OUTPUT_FAILED");
      assert.ok(!error.message.includes("SYNTHETIC_SECRET"));
      return true;
    });
    const stream = job.child[channel];
    assert.doesNotThrow(() => {
      stream.emit("error", new Error("SYNTHETIC_SECRET"));
      stream.emit("error", new Error("SYNTHETIC_SECRET_AGAIN"));
    });
    await rejected;
    assert.equal(r.active.size, 0);
    assert.equal(r.groupExists(job), false);
    assert.deepEqual(job.stdout, []);
  }
});

test("output is bounded and excluded from returned error", async (t) => {
  const r = runner(t, { maxOutputBytes: 1024 });
  const command = node(
    "process.stdout.write('SYNTHETIC_SECRET'.repeat(10000)); setInterval(()=>{},1000)",
  );
  await assert.rejects(r.run(command, 2000).promise, (error) => {
    assert.equal(error.code, "OUTPUT_LIMIT");
    assert.ok(!JSON.stringify(error).includes("SYNTHETIC_SECRET"));
    assert.ok(!error.message.includes(command));
    return true;
  });
  assert.equal(r.active.size, 0);
});

test("deadline terminates a real hung command and settles once", async (t) => {
  const r = runner(t);
  const start = Date.now();
  await assert.rejects(r.run(node("setInterval(()=>{},1000)"), 100).promise, {
    code: "TIMEOUT",
  });
  assert.ok(Date.now() - start < 1500);
  assert.equal(r.active.size, 0);
});

test("global concurrency and pending queue limits are enforced", async (t) => {
  const r = runner(t, { concurrency: 1, pendingLimit: 1 });
  const first = r.run(node("setInterval(()=>{},1000)"), 2000);
  const second = r.run("exit 0", 2000);
  const rejected = assert.rejects(r.run("exit 0", 2000).promise, {
    code: "QUEUE_FULL",
  });
  const cancelled = assert.rejects(first.promise, { code: "CANCELLED" });
  assert.equal(r.active.size, 1);
  assert.equal(r.pending.length, 1);
  first.cancel();
  await Promise.all([cancelled, rejected]);
  assert.deepEqual(await second.promise, { code: 0 });
});

test("same accessory stays serialized across controller replacement and cleanup", async (t) => {
  const r = runner(t, { concurrency: 4, pendingLimit: 1 });
  const first = r.run(node("setInterval(()=>{},1000)"), 2000, "same");
  const second = r.run("exit 0", 2000, "same");
  const full = assert.rejects(r.run("exit 0", 2000, "same").promise, {
    code: "QUEUE_FULL",
  });
  assert.equal(r.active.size, 1);
  assert.equal(r.pending.length, 1);
  const cancelled = assert.rejects(first.promise);
  first.cancel();
  await Promise.all([cancelled, full]);
  assert.deepEqual(await second.promise, { code: 0 });
});

test("queue waiting time is included in the execution deadline", async (t) => {
  const r = runner(t, { concurrency: 1 });
  const first = r.run(node("setInterval(()=>{},1000)"), 2000);
  const cancelled = assert.rejects(first.promise);
  const second = r.run("exit 0", 30);
  await assert.rejects(second.promise, { code: "TIMEOUT" });
  assert.equal(second.child, null);
  first.cancel();
  await cancelled;
});

test("shutdown cancels active and queued work and prevents new work", async (t) => {
  const r = runner(t, { concurrency: 1 });
  const a = assert.rejects(
    r.run(node("setInterval(()=>{},1000)"), 2000).promise,
  );
  const b = assert.rejects(r.run("exit 0", 2000).promise);
  r.dispose();
  await Promise.all([a, b]);
  await assert.rejects(r.run("exit 0", 100).promise, { code: "CANCELLED" });
  assert.equal(r.pending.length, 0);
  assert.equal(r.active.size, 0);
});

test(
  "POSIX cancellation kills a TERM-resistant descendant process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "cmdswitch-process-test-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const file = join(folder, "child.pid");
    const childScript = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(
      file,
    )},String(process.pid)); setInterval(()=>{},1000);`;
    const parentScript = `process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(
      childScript,
    )}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
    const r = runner(t);
    const job = r.run(node(parentScript), 4000);
    const rejection = assert.rejects(job.promise, { code: "CANCELLED" });
    for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(10);
    assert.ok(existsSync(file), "controlled child has started");
    const pid = Number(readFileSync(file));
    t.after(() => {
      if (running(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    });
    job.cancel();
    await rejection;
    for (let i = 0; i < 100 && running(pid); i++) await sleep(10);
    assert.equal(running(pid), false);
  },
);

test("dimmer environment preserves PATH and captures stdout only when requested", async (t) => {
  const r = runner(t);
  const command = node(
    "process.stdout.write(JSON.stringify({ level: process.env.HB_BRIGHTNESS, path: process.env.PATH }))",
  );
  const job = r.run(command, 2000, "dimmer", {
    env: { HB_BRIGHTNESS: "73" },
    captureStdout: true,
  });
  const result = await job.promise;
  assert.deepEqual(JSON.parse(result.stdout), {
    level: "73",
    path: process.env.PATH,
  });
  assert.equal(job.options, undefined);
  assert.deepEqual(job.stdout, []);
  assert.deepEqual(await r.run(command, 2000).promise, { code: 0 });
});

test("captured stdout remains bounded and is erased after output failure", async (t) => {
  const r = runner(t, { maxOutputBytes: 16 });
  const job = r.run("printf 'SYNTHETIC_SECRET_TO_DISCARD'", 1000, "dimmer", {
    captureStdout: true,
  });
  await assert.rejects(
    job.promise,
    (error) =>
      error.code === "OUTPUT_LIMIT" && !error.message.includes("SECRET"),
  );
  assert.deepEqual(job.stdout, []);
});

test("synchronous writes retain global acceptance order across switches and dimmers", async (t) => {
  const { SwitchController } = require("../switch-controller");
  const { normalizeSwitch } = require("../config");
  const r = runner(t, { concurrency: 1 });
  const dir = mkdtempSync(join(tmpdir(), "cmdswitch3-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "order");
  const command = (label) =>
    node(
      `require('node:fs').appendFileSync(${JSON.stringify(path)}, ${JSON.stringify(label)} + (process.env.HB_BRIGHTNESS || '') + '\\n'); setTimeout(()=>{},20)`,
    );
  const controllers = [
    new SwitchController(
      normalizeSwitch({
        name: "A",
        on_cmd: command("ON"),
        off_cmd: command("OFF"),
      }),
      {},
      r,
      () => {},
      () => {},
    ),
    new SwitchController(
      normalizeSwitch({ name: "B", dim_cmd: command("DIM") }),
      {},
      r,
      () => {},
      () => {},
    ),
  ];
  t.after(() => controllers.forEach((c) => c.dispose()));
  const operations = [
    controllers[0].set(true),
    controllers[0].set(false),
    controllers[1].setBrightness(45),
  ];
  await Promise.all(operations);
  assert.equal(readFileSync(path, "utf8"), "ON\nOFF\nDIM45\n");
  assert.equal(r.reservations.size, 0);
});

test("failed sequential action releases reserved slots so unrelated accessories continue", async (t) => {
  const { SwitchController } = require("../switch-controller");
  const { normalizeSwitch } = require("../config");
  const r = runner(t, { concurrency: 1 });
  const a = new SwitchController(
    normalizeSwitch({ name: "A", on_cmd: "exit 1", off_cmd: "exit 0" }),
    {},
    r,
    () => {},
    () => {},
  );
  const b = new SwitchController(
    normalizeSwitch({ name: "B", dim_cmd: "exit 0" }),
    {},
    r,
    () => {},
    () => {},
  );
  t.after(() => {
    a.dispose();
    b.dispose();
  });
  const failed = assert.rejects(a.set(true), { code: "ACTION_FAILED" });
  const cancelled = assert.rejects(a.set(false), { code: "CANCELLED" });
  await Promise.all([failed, cancelled, b.setBrightness(40)]);
  assert.equal(b.context.brightness, 40);
  assert.equal(r.reservations.size, 0);
});
