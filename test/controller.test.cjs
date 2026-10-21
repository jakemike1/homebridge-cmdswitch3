"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSwitch, normalizePlatform } = require("../config");
const { SwitchController } = require("../switch-controller");
const { failure } = require("../command-runner");
const turn = () => new Promise((resolve) => setImmediate(resolve));

class FakeRunner {
  constructor() {
    this.jobs = [];
  }
  run(command, timeout, key) {
    let resolve, reject;
    const job = {
      command,
      timeout,
      key,
      settled: false,
      promise: new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      done(code = 0) {
        if (!this.settled) {
          this.settled = true;
          resolve({ code });
        }
      },
      fail(error) {
        if (!this.settled) {
          this.settled = true;
          reject(error);
        }
      },
      cancel(error = failure("CANCELLED", "cancelled")) {
        this.fail(error);
      },
    };
    this.jobs.push(job);
    return job;
  }
  dispose() {
    this.jobs.forEach((job) => job.cancel());
  }
}

function fixture(t, options = {}) {
  const config = normalizeSwitch({
    name: "Test switch",
    on_cmd: "ON",
    off_cmd: "OFF",
    state_cmd: "STATE",
    polling: true,
    interval: 10,
    ...options,
  });
  const context = { name: config.name, state: false };
  const runner = new FakeRunner(),
    published = [],
    logs = [];
  const controller = new SwitchController(
    config,
    context,
    runner,
    (value) => published.push(value),
    (code) => logs.push(code),
  );
  t.after(() => controller.dispose());
  return { controller, runner, context, published, logs };
}

test("one in-flight read is shared by 100 poll/read requests", async (t) => {
  const f = fixture(t);
  const reads = Array.from({ length: 100 }, () => f.controller.refresh());
  assert.equal(f.runner.jobs.length, 1);
  f.runner.jobs[0].done();
  assert.deepEqual(await Promise.all(reads), Array(100).fill(true));
});

test("poll interval starts after completion; no unfinished check overlap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.controller.start();
  t.mock.timers.tick(1000000);
  assert.equal(f.runner.jobs.length, 1);
  f.runner.jobs[0].done();
  await turn();
  t.mock.timers.tick(9999);
  assert.equal(f.runner.jobs.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.runner.jobs.length, 2);
});

test("ON then OFF executes serially and ends OFF", async (t) => {
  const f = fixture(t);
  const on = f.controller.set(true),
    off = f.controller.set(false);
  await turn();
  assert.deepEqual(
    f.runner.jobs.map((job) => job.command),
    ["ON"],
  );
  f.runner.jobs[0].done();
  await on;
  await turn();
  assert.deepEqual(
    f.runner.jobs.map((job) => job.command),
    ["ON", "OFF"],
  );
  f.runner.jobs[1].done();
  await off;
  assert.equal(f.context.state, false);
});

test("old poll cannot overwrite new command state even if it ignores cancellation", async (t) => {
  const f = fixture(t);
  const read = f.controller.refresh();
  f.runner.jobs[0].cancel = () => {};
  const action = f.controller.set(true);
  f.runner.jobs[0].done(1);
  await read;
  await turn();
  f.runner.jobs[1].done();
  await action;
  assert.equal(f.context.state, true);
  assert.deepEqual(f.published, [true]);
});

test("failed action rejects even when cached state already matches", async (t) => {
  const f = fixture(t);
  f.context.state = true;
  const result = assert.rejects(f.controller.set(true), {
    code: "ACTION_FAILED",
  });
  await turn();
  f.runner.jobs[0].done(1);
  await result;
});

test("failure cancels queued intent without executing it", async (t) => {
  const f = fixture(t);
  const first = assert.rejects(f.controller.set(true), {
    code: "ACTION_FAILED",
  });
  const second = assert.rejects(f.controller.set(false), { code: "CANCELLED" });
  await turn();
  f.runner.jobs[0].done(1);
  await Promise.all([first, second]);
  assert.equal(f.runner.jobs.length, 1);
});

test("100 simultaneous writes have bounded growth and settle on disposal", async (t) => {
  const f = fixture(t);
  const results = Array.from({ length: 100 }, () =>
    f.controller.set(true).then(
      () => "success",
      (error) => error.code,
    ),
  );
  assert.ok(
    f.controller.queue.length + Number(Boolean(f.controller.active)) <= 8,
  );
  await turn();
  f.controller.dispose();
  const statuses = await Promise.all(results);
  assert.equal(statuses.filter((code) => code === "QUEUE_FULL").length, 92);
  assert.equal(statuses.filter((code) => code === "CANCELLED").length, 8);
});

test("legacy nonzero state is OFF; strict state mode rejects exit 2", async (t) => {
  const legacy = fixture(t),
    strict = fixture(t, { strictState: true });
  const oldRead = legacy.controller.refresh();
  const newRead = assert.rejects(strict.controller.refresh(), {
    code: "STATE_FAILED",
  });
  legacy.runner.jobs[0].done(2);
  strict.runner.jobs[0].done(2);
  assert.equal(await oldRead, false);
  await newRead;
});

test("execution failure retains state and returns Error, then recovers on success", async (t) => {
  const f = fixture(t);
  f.context.state = true;
  const read = assert.rejects(f.controller.refresh(), { code: "TIMEOUT" });
  f.runner.jobs[0].fail(failure("TIMEOUT", "deadline"));
  await read;
  assert.equal(f.context.state, true);
  await assert.rejects(f.controller.get(), { code: "TIMEOUT" });
  const recovery = f.controller.refresh();
  f.runner.jobs[1].done();
  await recovery;
  assert.equal(await f.controller.get(), true);
  assert.ok(f.published[0] instanceof Error);
});

test("non-polling startup explicitly reads state", async (t) => {
  const f = fixture(t, { polling: false });
  f.controller.start();
  assert.equal(f.runner.jobs[0].command, "STATE");
  f.runner.jobs[0].done();
  await turn();
  assert.equal(f.context.state, true);
});

test("one-command momentary reset publishes without issuing another command", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, {
    off_cmd: undefined,
    state_cmd: undefined,
    polling: false,
  });
  const action = f.controller.set(true);
  await turn();
  f.runner.jobs[0].done();
  await action;
  await turn();
  t.mock.timers.tick(1000);
  assert.deepEqual(f.published, [true, false]);
  assert.equal(f.runner.jobs.length, 1);
  await f.controller.set(false);
  assert.equal(f.runner.jobs.length, 1);
});

test("failed momentary action does not reset away its failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, {
    off_cmd: undefined,
    state_cmd: undefined,
    polling: false,
  });
  const result = assert.rejects(f.controller.set(true));
  await turn();
  f.runner.jobs[0].done(1);
  await result;
  await turn();
  t.mock.timers.tick(1000);
  assert.ok(f.published.at(-1) instanceof Error);
});

test("a state-backed missing direction rejects without executing undefined", async (t) => {
  const f = fixture(t, { off_cmd: undefined });
  await assert.rejects(f.controller.set(false), { code: "MISSING_COMMAND" });
  assert.equal(f.runner.jobs.length, 0);
});

test("shutdown cancels active reads, suppresses late publication and clears polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.controller.start();
  f.controller.dispose();
  await turn();
  t.mock.timers.tick(1000000);
  assert.equal(f.runner.jobs.length, 1);
  assert.deepEqual(f.published, []);
});

test("post-action refresh waits until action finishes, preserving timeout as delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { timeout: 2, polling: false });
  const action = f.controller.set(true);
  await turn();
  t.mock.timers.tick(2000);
  assert.equal(f.runner.jobs.length, 1);
  f.runner.jobs[0].done();
  await action;
  await turn();
  t.mock.timers.tick(2000);
  assert.equal(f.runner.jobs[1].command, "STATE");
});

test("invalid configuration rejected before any accessory mutation", () => {
  for (const value of [
    -1,
    0,
    0.5,
    "10seconds",
    NaN,
    Infinity,
    null,
    true,
    2147483647,
  ]) {
    assert.throws(() => normalizeSwitch({ name: "Test", interval: value }));
  }
  assert.throws(() =>
    normalizePlatform({
      switches: [{ name: "duplicate" }, { name: "duplicate" }],
    }),
  );
  assert.throws(() => normalizeSwitch({ name: "", on_cmd: "x" }));
  assert.throws(() => normalizeSwitch({ name: "X", on_cmd: 123 }));
  assert.throws(() => normalizeSwitch({ name: "X", polling: "true" }));
  assert.throws(() => normalizeSwitch({ name: "X", commandTimeout: 9 }));
  assert.equal(
    normalizeSwitch({ name: "constructor", interval: "10" }).interval,
    10,
  );
});

test("queued writes expire without starting and active writes receive a timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t, { commandTimeout: 1 });
  const first = assert.rejects(f.controller.set(true), { code: "TIMEOUT" });
  const second = assert.rejects(f.controller.set(false), { code: "TIMEOUT" });
  await turn();
  t.mock.timers.tick(1000);
  await Promise.all([first, second]);
  assert.equal(f.runner.jobs.length, 1);
});

test("repeated identical read failures log once until successful recovery", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    const read = assert.rejects(f.controller.refresh());
    f.runner.jobs.at(-1).fail(failure("TIMEOUT", "deadline"));
    await read;
  }
  assert.deepEqual(f.logs, ["TIMEOUT"]);
  const read = f.controller.refresh();
  f.runner.jobs.at(-1).done();
  await read;
  const failAgain = assert.rejects(f.controller.refresh());
  f.runner.jobs.at(-1).fail(failure("TIMEOUT", "deadline"));
  await failAgain;
  assert.deepEqual(f.logs, ["TIMEOUT", "TIMEOUT"]);
});

module.exports = { FakeRunner, turn };

test("shutdown rejects a waiting GET instead of acknowledging stale state", async (t) => {
  const f = fixture(t, { polling: false });
  const get = assert.rejects(f.controller.get(), { code: "CANCELLED" });
  f.controller.dispose();
  await get;
});
