import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const hbPath =
  process.env.HOMEBRIDGE_PATH ||
  dirname(dirname(require.resolve("homebridge")));
const requireHB = createRequire(join(hbPath, "package.json"));
const manifest = JSON.parse(readFileSync(join(hbPath, "package.json"), "utf8"));
const hapName = "@homebridge/hap-nodejs";
const hap = requireHB(hapName);
const { IdentifierCache } = await import(
  pathToFileURL(
    join(dirname(requireHB.resolve(hapName)), "lib/model/IdentifierCache.js"),
  )
);
const { PlatformAccessory } = await import(
  pathToFileURL(join(hbPath, "dist/platformAccessory.js"))
);
const initialize = require("../index.js");
const { failure } = require("../command-runner");
const oldSource = readFileSync(
  new URL("./fixtures/original-index.js", import.meta.url),
  "utf8",
);
const names = [
  "Bedroom",
  "Living Room",
  "Office",
  "Canal Plus",
  "Server",
  "Transmission",
];
const settings = names.map((name) => ({
  name,
  on_cmd: "SYNTHETIC_ON",
  off_cmd: name === "Transmission" ? "/bin/true" : "SYNTHETIC_OFF",
  state_cmd: "SYNTHETIC_STATE",
  polling: true,
  interval: 10,
}));
settings.push({
  name: "Test Dimmer",
  dim_cmd: "SYNTHETIC_DIM",
  off_cmd: "SYNTHETIC_OFF",
  state_cmd: "SYNTHETIC_DIM_STATE",
  brightness: 37,
  polling: false,
});
const turn = () => new Promise((resolve) => setImmediate(resolve));
console.log(
  `Real Homebridge ${manifest.version}, Node ${process.version}; synthetic accessories, no server publication`,
);

class FakeRunner {
  jobs = [];
  run(command, timeout, key, options) {
    let resolve, reject;
    const job = {
      command,
      options,
      promise: new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      done: (code = 0, stdout = "37") => resolve({ code, stdout }),
      cancel: () => reject(failure("CANCELLED", "cancelled")),
    };
    this.jobs.push(job);
    return job;
  }
  dispose() {
    this.jobs.forEach((job) => job.cancel());
  }
}

function fixture(t, config = { switches: settings }, init = initialize) {
  let Platform;
  const registered = [],
    removed = [],
    logs = [];
  const api = Object.assign(new EventEmitter(), {
    hap,
    versionGreaterOrEqual: () => true,
    // The archived source calls APIs removed by modern Homebridge. These
    // inert legacy adapters build its exact service/cache layout without reads.
    platformAccessory:
      init === initialize
        ? PlatformAccessory
        : class extends PlatformAccessory {
            updateReachability(value) {
              this.reachable = value;
            }
            addService(...args) {
              const service = super.addService(...args);
              const originalGet = service.getCharacteristic.bind(service);
              service.getCharacteristic = (...args) => {
                const characteristic = originalGet(...args);
                characteristic.getValue = () => characteristic;
                return characteristic;
              };
              return service;
            }
          },
    registerPlatform(plugin, alias, Type, dynamic) {
      assert.equal(
        plugin,
        init === initialize ? "homebridge-cmdswitch3" : "homebridge-cmdswitch2",
      );
      assert.equal(alias, init === initialize ? "cmdSwitch3" : "cmdSwitch2");
      assert.equal(dynamic, true);
      Platform = Type;
    },
    registerPlatformAccessories(plugin, alias, list) {
      for (const accessory of list) {
        accessory._associatedPlugin = plugin;
        accessory._associatedPlatform = alias;
      }
      registered.push(...list);
    },
    unregisterPlatformAccessories(_plugin, _alias, list) {
      removed.push(...list);
    },
  });
  init(api);
  const p = new Platform(
    (...args) => logs.push(args.join(" ")),
    structuredClone(config),
    api,
  );
  const runner = new FakeRunner();
  if (p.runner) {
    p.runner.dispose();
    p.runner = runner;
  }
  t.after(() => p.dispose?.());
  return { api, p, runner, registered, removed, logs };
}

function oldInitializer() {
  const childProcess = {
    exec(_command, options, callback) {
      (typeof options === "function" ? options : callback)(null, "37", "");
    },
  };
  const queueContext = { module: { exports: {} }, require: () => childProcess };
  vm.runInNewContext(
    readFileSync(
      new URL("./fixtures/original-ExecQueue.js", import.meta.url),
      "utf8",
    ),
    queueContext,
  );
  const context = {
    module: { exports: {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    require(name) {
      if (name === "child_process") return childProcess;
      assert.equal(name, "./ExecQueue");
      return queueContext.module.exports;
    },
  };
  vm.runInNewContext(oldSource, context);
  return context.module.exports;
}

function identity(accessory) {
  return {
    name: accessory.displayName,
    UUID: accessory.UUID,
    category: accessory.category,
    plugin: accessory._associatedPlugin,
    platform: accessory._associatedPlatform,
    aid: accessory._associatedHAPAccessory.aid,
    services: accessory.services.map((service) => ({
      uuid: service.UUID,
      subtype: service.subtype,
      iid: service.iid,
      primary: service.isPrimaryService,
      links: service.linkedServices.map((link) => [link.UUID, link.subtype]),
      characteristics: service.characteristics.map((c) => ({
        uuid: c.UUID,
        iid: c.iid,
        props: c.props,
      })),
    })),
  };
}

function assign(accessories, cache) {
  const bridge = new hap.Bridge(
    "Synthetic bridge",
    hap.uuid.generate("cmdswitch-audit-bridge"),
  );
  for (const accessory of accessories)
    bridge.addBridgedAccessory(accessory._associatedHAPAccessory);
  bridge._assignIDs(cache);
  return bridge;
}

test("original switches and dimmer retain HAP identities after explicit synthetic cache reassociation", async (t) => {
  const original = fixture(t, { switches: settings }, oldInitializer());
  original.api.emit("didFinishLaunching");
  const cache = new IdentifierCache("AA:00:00:00:00:01");
  const restored = Object.values(original.p.accessories).map((a) =>
    PlatformAccessory.deserialize(PlatformAccessory.serialize(a)),
  );
  for (const accessory of restored) {
    assert.equal(accessory._associatedPlugin, "homebridge-cmdswitch2");
    // A future migration must deliberately transfer these associations on the
    // SAME bridge. The plugin never claims another plugin's cache itself.
    accessory._associatedPlugin = "homebridge-cmdswitch3";
    accessory._associatedPlatform = "cmdSwitch3";
  }
  assign(restored, cache);
  const before = restored.map(identity);
  const current = fixture(t);
  restored.forEach((a) => current.p.configureAccessory(a));
  current.api.emit("didFinishLaunching");
  current.runner.jobs.forEach((job) => job.done());
  await turn();
  assert.deepEqual(restored.map(identity), before);
  assert.equal(current.registered.length, 0);
  assert.equal(current.removed.length, 0);
  for (const accessory of restored) {
    assert.equal(current.p.accessories[accessory.context.name], accessory);
    assert.equal(
      accessory
        .getService(
          accessory.context.name === "Test Dimmer"
            ? hap.Service.Lightbulb
            : hap.Service.Switch,
        )
        .getCharacteristic(hap.Characteristic.On).setHandler instanceof
        Function,
      true,
    );
    assert.equal(Object.hasOwn(accessory.context, "dim_cmd"), false);
    assert.equal(Object.hasOwn(accessory.context, "on_cmd"), false);
    assert.equal(Object.hasOwn(accessory.context, "off_cmd"), false);
    assert.equal(Object.hasOwn(accessory.context, "state_cmd"), false);
  }
  // Repeat through a complete persisted-cache reconstruction with the same ID cache.
  const reloaded = restored.map((a) =>
    PlatformAccessory.deserialize(PlatformAccessory.serialize(a)),
  );
  assign(reloaded, cache);
  const again = fixture(t);
  reloaded.forEach((a) => again.p.configureAccessory(a));
  again.api.emit("didFinishLaunching");
  again.runner.jobs.forEach((job) => job.done());
  await turn();
  assert.deepEqual(reloaded.map(identity), before);
  assert.equal(again.registered.length, 0);
  assert.equal(again.removed.length, 0);
});

test("Transmission OFF still executes exactly /bin/true and preserves the Switch service", async (t) => {
  const f = fixture(t);
  f.api.emit("didFinishLaunching");
  f.runner.jobs.forEach((job) => job.done());
  await turn();
  const a = f.p.accessories.Transmission;
  const on = a
    .getService(hap.Service.Switch)
    .getCharacteristic(hap.Characteristic.On);
  const operation = on.handleSetRequest(false);
  await turn();
  assert.equal(f.runner.jobs.at(-1).command, "/bin/true");
  f.runner.jobs.at(-1).done();
  await operation;
  assert.equal(
    a.services.filter((service) => service.UUID === hap.Service.Switch.UUID)
      .length,
    1,
  );
});

test("actual HAP write rejects command failure and succeeds after recovery", async (t) => {
  const f = fixture(t);
  f.api.emit("didFinishLaunching");
  f.runner.jobs.forEach((job) => job.done());
  await turn();
  const on = f.p.accessories.Bedroom.getService(
    hap.Service.Switch,
  ).getCharacteristic(hap.Characteristic.On);
  const failed = assert.rejects(on.handleSetRequest(true));
  await turn();
  f.runner.jobs.at(-1).done(1);
  await failed;
  await turn();
  const success = on.handleSetRequest(true);
  await turn();
  f.runner.jobs.at(-1).done(0);
  await success;
  assert.equal(on.value, true);
});

test("reconfiguration disables polls without replacing services or duplicating listeners", async (t) => {
  const f = fixture(t);
  f.api.emit("didFinishLaunching");
  f.runner.jobs.forEach((job) => job.done());
  await turn();
  const a = f.p.accessories.Bedroom,
    before = identity(a),
    old = f.p.controllers.get("Bedroom");
  const replacement = f.p.addAccessory({ ...settings[0], polling: false });
  f.runner.jobs.at(-1).done();
  await turn();
  assert.equal(old.closed, true);
  assert.equal(replacement, a);
  assert.deepEqual(identity(a), before);
  assert.equal(
    a.getService(hap.Service.Switch).getCharacteristic(hap.Characteristic.On)
      .setHandler instanceof Function,
    true,
  );
  assert.equal(f.p.controllers.get("Bedroom").pollTimer, null);
});

test("prototype names are ordinary switches, while duplicate config is rejected", (t) => {
  const f = fixture(t, {
    switches: ["constructor", "__proto__"].map((name) => ({
      name,
      on_cmd: "ON",
      off_cmd: "OFF",
    })),
  });
  f.api.emit("didFinishLaunching");
  assert.equal(f.registered.length, 2);
  const invalid = fixture(t, { switches: [{ name: "X" }, { name: "X" }] });
  assert.equal(invalid.p.disabled, true);
  assert.match(invalid.logs.join(), /Duplicate switch name/);
  assert.doesNotThrow(() => invalid.api.emit("didFinishLaunching"));
  assert.equal(invalid.registered.length, 0);
  assert.equal(invalid.removed.length, 0);
});

test("malformed cached services are retained with an error instead of silently replaced", (t) => {
  const f = fixture(t);
  const a = new PlatformAccessory("Broken", hap.uuid.generate("Broken"), 8);
  a.context.name = "Broken";
  assert.doesNotThrow(() => f.p.configureAccessory(a));
  assert.equal(f.p.disabled, true);
  assert.match(f.logs.join(), /Invalid cached accessory identity or services/);
  assert.doesNotThrow(() => f.api.emit("didFinishLaunching"));
  assert.equal(f.removed.length, 0);
  assert.equal(f.registered.length, 0);
});

test("shutdown unsubscribes handlers, stops work and does not unregister accessories", async (t) => {
  const f = fixture(t);
  f.api.emit("didFinishLaunching");
  f.api.emit("shutdown");
  await turn();
  for (const a of Object.values(f.p.accessories)) {
    assert.equal(
      a
        .getService(
          a.context.name === "Test Dimmer"
            ? hap.Service.Lightbulb
            : hap.Service.Switch,
        )
        .getCharacteristic(hap.Characteristic.On).setHandler,
      undefined,
    );
  }
  assert.equal(f.removed.length, 0);
});

test("Homebridge 1 is explicitly rejected before any platform registration", () => {
  assert.throws(
    () => initialize({ versionGreaterOrEqual: () => false }),
    /requires Homebridge 2/,
  );
});

test("no-logs is opt-in and never suppresses command failures", async (t) => {
  for (const noLogs of [undefined, true]) {
    const f = fixture(t, {
      noLogs,
      switches: [{ name: "Quiet", on_cmd: "SECRET_COMMAND", off_cmd: "OFF" }],
    });
    f.api.emit("didFinishLaunching");
    const c = f.p.controllers.get("Quiet");
    const success = c.set(true);
    await turn();
    f.runner.jobs.at(-1).done();
    await success;
    await turn();
    if (noLogs) assert.deepEqual(f.logs, []);
    else assert.ok(f.logs.some((message) => message.includes("Turned on")));
    const count = f.logs.length;
    const failed = assert.rejects(c.set(true));
    await turn();
    f.runner.jobs.at(-1).done(1);
    await failed;
    assert.equal(f.logs.length, count + 1);
    assert.ok(f.logs.at(-1).includes("ACTION_FAILED"));
    assert.ok(!f.logs.join().includes("SECRET_COMMAND"));
  }
});

test("cached type mismatch aborts the whole launch before adding or removing accessories", (t) => {
  const f = fixture(t, {
    switches: [
      { name: "New", on_cmd: "ON" },
      { name: "Existing", dim_cmd: "DIM" },
    ],
  });
  const existing = new PlatformAccessory(
    "Existing",
    hap.uuid.generate("Existing"),
    8,
  );
  existing.context.name = "Existing";
  existing.addService(hap.Service.Switch, "Existing");
  f.p.configureAccessory(existing);
  assert.doesNotThrow(() => f.api.emit("didFinishLaunching"));
  assert.equal(f.p.disabled, true);
  assert.match(f.logs.join(), /Cached accessory type differs/);
  assert.equal(f.registered.length, 0);
  assert.equal(f.removed.length, 0);
  assert.equal(f.p.controllers.size, 0);
});

test("actual HAP dimmer writes and GETs expose coherent On and Brightness values", async (t) => {
  const f = fixture(t, {
    switches: [{ name: "Light", dim_cmd: "DIM", off_cmd: "OFF" }],
  });
  f.api.emit("didFinishLaunching");
  const service = f.p.accessories.Light.getService(hap.Service.Lightbulb);
  const level = service.getCharacteristic(hap.Characteristic.Brightness),
    on = service.getCharacteristic(hap.Characteristic.On);
  const set = level.handleSetRequest(62);
  await turn();
  f.runner.jobs.at(-1).done();
  await set;
  assert.equal(await on.handleGetRequest(), true);
  assert.equal(await level.handleGetRequest(), 62);
  const off = on.handleSetRequest(false);
  await turn();
  f.runner.jobs.at(-1).done();
  await off;
  assert.equal(await on.handleGetRequest(), false);
  assert.equal(await level.handleGetRequest(), 0);
  const restore = on.handleSetRequest(true);
  await turn();
  assert.equal(f.runner.jobs.at(-1).options.env.HB_BRIGHTNESS, "62");
  f.runner.jobs.at(-1).done();
  await restore;
  assert.equal(await level.handleGetRequest(), 62);
  const failure = assert.rejects(level.handleSetRequest(90));
  await turn();
  f.runner.jobs.at(-1).done(2);
  await failure;
  assert.equal(f.p.accessories.Light.context.brightness, 62);
});

test("sequential setting configures a single runner; the old wizard is absent", (t) => {
  let Platform;
  initialize({
    hap,
    versionGreaterOrEqual: () => true,
    registerPlatform: (_p, _a, type) => {
      Platform = type;
    },
  });
  for (const synchronous of [false, true]) {
    const p = new Platform(
      () => {},
      { synchronous, maxConcurrentCommands: 4, switches: [] },
      new EventEmitter(),
    );
    t.after(() => p.dispose());
    assert.equal(p.runner.concurrency, synchronous ? 1 : 4);
    assert.equal(p.configurationRequestHandler, undefined);
  }
});

function cachedSwitch(name = "Existing", uuidName = name) {
  const accessory = new PlatformAccessory(name, hap.uuid.generate(uuidName), 8);
  accessory.context = { name, state: true };
  accessory.addService(hap.Service.Switch, name);
  return accessory;
}

test("missing switch configuration stays inert and retains cached accessories with unavailable handlers", async (t) => {
  for (const config of [null, {}, { platform: "cmdSwitch3", noLogs: true }]) {
    const f = fixture(t, config);
    const accessory = cachedSwitch();
    const before = identity(accessory);
    f.p.configureAccessory(accessory);
    f.api.emit("didFinishLaunching");
    assert.equal(f.p.configured, false);
    assert.equal(f.p.runner, undefined);
    assert.equal(f.p.controllers.size, 0);
    assert.deepEqual(identity(accessory), before);
    assert.equal(f.registered.length, 0);
    assert.equal(f.removed.length, 0);
    const on = accessory
      .getService(hap.Service.Switch)
      .getCharacteristic(hap.Characteristic.On);
    await assert.rejects(on.handleGetRequest());
    await assert.rejects(on.handleSetRequest(false));
    assert.deepEqual(f.logs, []);
  }
});

test("invalid configuration logs safe errors even in quiet mode and never escapes lifecycle callbacks", async (t) => {
  for (const config of [
    { switches: null },
    { switches: [{ name: "" }] },
    {
      switches: [{ name: "Existing", on_cmd: { secret: "SYNTHETIC_SECRET" } }],
    },
    { switches: [{ name: "Existing", interval: "SYNTHETIC_SECRET" }] },
    { switches: [], maxConcurrentCommands: 0 },
  ]) {
    const f = fixture(t, { ...config, noLogs: true });
    const accessory = cachedSwitch();
    const before = identity(accessory);
    let otherListenerRan = false;
    f.api.on("didFinishLaunching", () => {
      otherListenerRan = true;
    });
    assert.doesNotThrow(() => f.p.configureAccessory(accessory));
    assert.doesNotThrow(() => f.api.emit("didFinishLaunching"));
    assert.equal(otherListenerRan, true);
    assert.equal(f.p.disabled, true);
    assert.deepEqual(identity(accessory), before);
    assert.equal(f.registered.length, 0);
    assert.equal(f.removed.length, 0);
    assert.equal(f.runner.jobs.length, 0);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /cmdSwitch3 disabled/);
    assert.ok(!f.logs[0].includes("SYNTHETIC_SECRET"));
    await assert.rejects(f.p.handle(accessory.context, "set", false));
  }
});

test("ambiguous cached identities or services disable startup without replacing or deleting anything", (t) => {
  for (const defect of [
    "uuid",
    "name",
    "context-null",
    "duplicate",
    "multiple-switches",
    "mixed-types",
  ]) {
    const f = fixture(t, { switches: [{ name: "Existing" }, { name: "New" }] });
    const existing = cachedSwitch();
    f.p.configureAccessory(existing);
    const broken = cachedSwitch(
      "Broken",
      defect === "uuid" ? "Different" : "Broken",
    );
    if (defect === "name") delete broken.context.name;
    if (defect === "context-null") broken.context = null;
    if (defect === "duplicate") {
      broken.context.name = "Existing";
      broken.UUID = existing.UUID;
    }
    if (defect === "multiple-switches")
      broken.addService(hap.Service.Switch, "Second", "second");
    if (defect === "mixed-types")
      broken.addService(hap.Service.Lightbulb, "Other");
    const before = [existing, broken].map(identity);
    assert.doesNotThrow(() => f.p.configureAccessory(broken));
    assert.doesNotThrow(() => f.api.emit("didFinishLaunching"));
    assert.equal(f.p.disabled, true);
    assert.deepEqual([existing, broken].map(identity), before);
    assert.equal(f.registered.length, 0);
    assert.equal(f.removed.length, 0);
    assert.equal(f.runner.jobs.length, 0);
    let identified = false;
    assert.doesNotThrow(() =>
      broken.emit("identify", false, () => {
        identified = true;
      }),
    );
    if (!["multiple-switches", "mixed-types"].includes(defect))
      assert.equal(identified, true);
    f.api.emit("shutdown");
    assert.equal(f.p.bindings.size, 0);
  }
});

test("explicit empty switches allows intentional removal; repeated launch cannot duplicate commands", (t) => {
  const empty = fixture(t, { switches: [] });
  const accessory = cachedSwitch();
  empty.p.configureAccessory(accessory);
  empty.api.emit("didFinishLaunching");
  assert.deepEqual(empty.removed, [accessory]);
  empty.api.emit("didFinishLaunching");
  assert.equal(empty.removed.length, 1);

  const f = fixture(t);
  f.api.emit("didFinishLaunching");
  const jobs = f.runner.jobs.length;
  f.api.emit("didFinishLaunching");
  assert.equal(f.runner.jobs.length, jobs);
  assert.equal(f.registered.length, settings.length);
});

test("unexpected startup errors are sanitized, stop active work and preserve unrelated cached accessories", async (t) => {
  const f = fixture(t, {
    noLogs: true,
    switches: [
      { name: "Existing", state_cmd: "SYNTHETIC_STATE" },
      { name: "New" },
    ],
  });
  const retained = [cachedSwitch(), cachedSwitch("Retained")];
  const before = retained.map(identity);
  retained.forEach((accessory) => f.p.configureAccessory(accessory));
  f.api.registerPlatformAccessories = () => {
    throw new Error("SYNTHETIC_SECRET");
  };
  assert.doesNotThrow(() => f.api.emit("didFinishLaunching"));
  await turn();
  assert.equal(f.p.disabled, true);
  assert.equal(f.removed.length, 0);
  assert.deepEqual(retained.map(identity), before);
  assert.ok(
    [...f.p.controllers.values()].every((controller) => controller.closed),
  );
  assert.match(f.logs.join(), /Accessory startup failed/);
  assert.ok(!f.logs.join().includes("SYNTHETIC_SECRET"));
  await assert.rejects(f.p.handle(retained[0].context, "get"));
});

test("failed state publication during a read returns a HAP error and stops background polling", async (t) => {
  const f = fixture(t, {
    noLogs: true,
    switches: [{ name: "Existing", state_cmd: "STATE" }],
  });
  f.api.emit("didFinishLaunching");
  const on = f.p.accessories.Existing.getService(
    hap.Service.Switch,
  ).getCharacteristic(hap.Characteristic.On);
  on.updateValue = () => {
    throw new Error("SYNTHETIC_SECRET");
  };
  const read = assert.rejects(on.handleGetRequest());
  f.runner.jobs[0].done();
  await read;
  await turn();
  assert.equal(f.p.disabled, true);
  assert.match(f.logs.join(), /Could not update accessory state/);
  assert.ok(!f.logs.join().includes("SYNTHETIC_SECRET"));
  assert.equal(f.removed.length, 0);
  assert.equal(f.p.controllers.get("Existing").pollTimer, null);
});

test("momentary reset publication errors are contained outside request handlers", async (t) => {
  const f = fixture(t, {
    noLogs: true,
    switches: [{ name: "Momentary", on_cmd: "ON" }],
  });
  f.api.emit("didFinishLaunching");
  const on = f.p.accessories.Momentary.getService(
    hap.Service.Switch,
  ).getCharacteristic(hap.Characteristic.On);
  const write = on.handleSetRequest(true);
  await turn();
  f.runner.jobs[0].done();
  await write;
  await turn();
  on.updateValue = () => {
    throw new Error("SYNTHETIC_SECRET");
  };
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.p.disabled, true);
  assert.match(f.logs.join(), /Could not update accessory state/);
  assert.ok(!f.logs.join().includes("SYNTHETIC_SECRET"));
  assert.equal(f.runner.jobs.length, 1);
});

test("platform shutdown closes the scheduler before releasing a blocked command", async (t) => {
  const { CommandRunner } = require("../command-runner");
  const f = fixture(t, { switches: [], synchronous: true });
  f.p.runner = new CommandRunner({ concurrency: 1 });
  const reservation = f.p.runner.reserve();
  const blocked = f.p.runner.run("exit 0", 2000);
  const cancelled = assert.rejects(blocked.promise, { code: "CANCELLED" });
  f.p.controllers.set("Reserved", {
    dispose: () => f.p.runner.release(reservation),
  });
  f.api.emit("shutdown");
  await cancelled;
  assert.equal(blocked.child, null);
});
