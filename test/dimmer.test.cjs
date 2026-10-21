"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSwitch } = require("../config");
const { SwitchController } = require("../switch-controller");
const { failure } = require("../command-runner");
const { FakeRunner, turn } = require("./helpers.cjs");
function fixture(t, options = {}, cached = {}) {
  const runner = new FakeRunner(),
    published = [],
    logs = [];
  const context = { name: "Dimmer", state: false, ...cached };
  const config = normalizeSwitch({
    name: "Dimmer",
    dim_cmd: "DIM",
    ...options,
  });
  const controller = new SwitchController(
    config,
    context,
    runner,
    (value, level) => published.push([value, level]),
    (code) => logs.push(code),
  );
  t.after(() => controller.dispose());
  return { runner, published, logs, context, controller };
}
async function complete(f, operation, code = 0, stdout = "") {
  await turn();
  f.runner.jobs.at(-1).done(code, stdout);
  await operation;
  await turn();
}
test("brightness writes pass HB_BRIGHTNESS and publish only after success", async (t) => {
  const f = fixture(t, {}, { brightness: 40 });
  const operation = f.controller.setBrightness(75);
  await turn();
  assert.equal(f.context.brightness, 40);
  assert.equal(f.context.state, false);
  assert.equal(f.runner.jobs[0].options.env.HB_BRIGHTNESS, "75");
  await complete(f, operation);
  assert.deepEqual(f.published, [[true, 75]]);
});
test("OFF and ON restore the latest successful level across queued dimmer writes", async (t) => {
  const f = fixture(t, { off_cmd: "OFF" });
  const operations = [
    f.controller.setBrightness(65),
    f.controller.set(false),
    f.controller.set(true),
  ];
  for (const operation of operations) await complete(f, operation);
  assert.deepEqual(
    f.runner.jobs.map((j) => [j.command, j.options.env.HB_BRIGHTNESS]),
    [
      ["DIM", "65"],
      ["OFF", "0"],
      ["DIM", "65"],
    ],
  );
  assert.deepEqual(f.published, [
    [true, 65],
    [false, 0],
    [true, 65],
  ]);
});
test("dimmer without OFF command dims to zero and remembers last nonzero level", async (t) => {
  const f = fixture(t, {}, { brightness: 28 });
  await complete(f, f.controller.set(false));
  assert.equal(f.runner.jobs[0].command, "DIM");
  assert.equal(f.context.brightness, 0);
  await complete(f, f.controller.set(true));
  assert.equal(f.context.brightness, 28);
});
test("initial dimmer ON uses a useful default; cached positive level survives restart", async (t) => {
  const fresh = fixture(t, { brightness: 0 });
  await complete(fresh, fresh.controller.set(true));
  assert.equal(fresh.context.brightness, 100);
  const restored = fixture(
    t,
    { brightness: 100 },
    { brightness: 0, lastBrightness: 22 },
  );
  await complete(restored, restored.controller.set(true));
  assert.equal(restored.context.brightness, 22);
});
test("failed dimmer writes retain state and brightness and cancel later queued intent", async (t) => {
  const f = fixture(t, {}, { state: true, brightness: 36 });
  const failed = assert.rejects(f.controller.setBrightness(75), {
    code: "ACTION_FAILED",
  });
  const cancelled = assert.rejects(f.controller.set(false), {
    code: "CANCELLED",
  });
  await turn();
  f.runner.jobs[0].done(3);
  await Promise.all([failed, cancelled]);
  await turn();
  assert.equal(f.context.brightness, 36);
  assert.equal(f.context.state, true);
  assert.equal(f.runner.jobs.length, 1);
  assert.ok(f.published.at(-1)[0] instanceof Error);
});
test("On and Brightness GETs share one numeric state read", async (t) => {
  const f = fixture(t, { state_cmd: "READ" });
  const reads = [f.controller.get(), f.controller.getBrightness()];
  assert.equal(f.runner.jobs.length, 1);
  assert.equal(f.runner.jobs[0].options.captureStdout, true);
  f.runner.jobs[0].done(0, " 42\n");
  assert.deepEqual(await Promise.all(reads), [true, 42]);
  assert.deepEqual(f.published, [[true, 42]]);
});
test("zero state is OFF but preserves last brightness for ON", async (t) => {
  const f = fixture(
    t,
    { state_cmd: "READ", polling: true },
    { state: true, brightness: 61 },
  );
  const read = f.controller.refresh();
  f.runner.jobs[0].done(0, "0\n");
  await read;
  assert.equal(f.context.state, false);
  assert.equal(f.context.lastBrightness, 61);
  await complete(f, f.controller.set(true));
  assert.equal(f.context.brightness, 61);
});
test("malformed and out-of-range dimmer reads fail without leaking output or overwriting state", async (t) => {
  const f = fixture(
    t,
    { state_cmd: "READ", polling: true },
    { state: true, brightness: 31 },
  );
  for (const stdout of ["", "-1", "101", "5.5", "token=SECRET42", "40\n50"]) {
    const read = assert.rejects(f.controller.refresh(), {
      code: "INVALID_STATE",
    });
    f.runner.jobs.at(-1).done(0, stdout);
    await read;
    assert.equal(f.context.brightness, 31);
    assert.equal(f.context.state, true);
  }
  assert.deepEqual(f.logs, ["INVALID_STATE"]);
  assert.ok(!JSON.stringify(f.published).includes("SECRET"));
});
test("dimmer strict state mode rejects execution errors and recovers", async (t) => {
  const f = fixture(t, { state_cmd: "READ", strictState: true });
  const failed = assert.rejects(f.controller.refresh(), {
    code: "STATE_FAILED",
  });
  f.runner.jobs[0].done(2, "80");
  await failed;
  const read = f.controller.refresh();
  f.runner.jobs[1].done(0, "80");
  await read;
  assert.equal(f.context.brightness, 80);
  assert.equal(f.controller.lastError, null);
});
test("stale dimmer state result cannot undo a newer brightness action", async (t) => {
  const f = fixture(t, { state_cmd: "READ" });
  const read = f.controller.refresh();
  f.runner.jobs[0].cancel = () => {};
  const write = f.controller.setBrightness(70);
  f.runner.jobs[0].done(0, "15");
  await read;
  assert.notEqual(f.context.brightness, 15);
  await complete(f, write);
  assert.equal(f.context.brightness, 70);
});
test("dimmer polling waits for completion and one-sided dimmers never momentarily reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  await complete(f, f.controller.setBrightness(55));
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(f.context.brightness, 55);
  assert.equal(f.context.state, true);
  assert.equal(f.runner.jobs.length, 1);
});
test("invalid brightness values never invoke a command", async (t) => {
  const f = fixture(t);
  for (const value of [-1, 101, 2.2, NaN, Infinity, true, "50", null])
    await assert.rejects(f.controller.setBrightness(value), {
      code: "INVALID_VALUE",
    });
  assert.equal(f.runner.jobs.length, 0);
});
test("shutdown cancels dimmer writes and prevents late publication", async (t) => {
  const f = fixture(t);
  const write = assert.rejects(f.controller.setBrightness(50), {
    code: "CANCELLED",
  });
  await turn();
  f.controller.dispose();
  await write;
  await turn();
  assert.equal(f.published.length, 0);
  await assert.rejects(f.controller.getBrightness(), { code: "CANCELLED" });
});
