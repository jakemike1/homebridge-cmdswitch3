"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const Ajv = require("ajv");
const schema = require("../config.schema.json");
const { normalizePlatform } = require("../config");
const { turn } = require("./helpers.cjs");
const initial = [
  {
    platform: "cmdSwitch3",
    name: "Mine",
    _bridge: { username: "SYNTHETIC_ONLY" },
    futureOption: { keep: true },
    switches: [
      {
        name: "Office",
        on_cmd: "ORIGINAL_ON",
        off_cmd: "/bin/true",
        state_cmd: "STATE",
        polling: true,
        interval: 10,
        customField: "preserve",
      },
      { name: "Lamp", dim_cmd: "DIM", brightness: 30 },
    ],
  },
];
async function fixture(t, configuration = initial, update) {
  const dom = new JSDOM(
    readFileSync("homebridge-ui/public/index.html", "utf8"),
    { runScripts: "outside-only", url: "http://localhost/" },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    state = { enabled: false, updates: [], saves: 0 };
  w.structuredClone = structuredClone;
  w.homebridge = Object.assign(new w.EventTarget(), {
    getPluginConfig: async () => structuredClone(configuration),
    getPluginConfigSchema: async () => structuredClone(schema),
    userCurrentLightingMode: async () => "light",
    disableSaveButton: () => {
      state.enabled = false;
    },
    enableSaveButton: () => {
      state.enabled = true;
    },
    updatePluginConfig: async (blocks) => {
      state.updates.push(structuredClone(blocks));
      await update?.(blocks);
      return blocks;
    },
    savePluginConfig: async () => {
      state.saves++;
    },
  });
  for (const file of ["validation.js", "settings.js"])
    w.eval(readFileSync("homebridge-ui/public/" + file, "utf8"));
  w.homebridge.dispatchEvent(new w.Event("ready"));
  await turn();
  const input = (id, value, kind = "input") => {
    const node = w.document.getElementById(id);
    assert.ok(node, id);
    if (node.type === "checkbox") node.checked = value;
    else node.value = value;
    node.dispatchEvent(new w.Event(kind, { bubbles: true }));
  };
  return { w, state, input, doc: w.document };
}
test("schema and runtime agree on new defaults, bounds and command options", () => {
  const validate = new Ajv({ strict: false }).compile(schema.schema);
  assert.equal(schema.customUi, true);
  assert.equal(schema.pluginAlias, "cmdSwitch3");
  assert.equal(schema.schema.properties.name.default, "cmdSwitch3");
  assert.equal(schema.schema.properties.noLogs.default, false);
  const good = {
    noLogs: true,
    synchronous: true,
    switches: [{ name: "Lamp", dim_cmd: "DIM", brightness: 50, interval: 10 }],
  };
  assert.ok(validate(good));
  assert.ok(normalizePlatform(good));
  for (const bad of [
    { noLogs: "true" },
    { synchronous: 1 },
    { switches: [{ name: " " }] },
    { switches: [{ name: "X", brightness: 101 }] },
    { maxConcurrentCommands: 0 },
  ]) {
    assert.equal(validate(bad), false);
    assert.throws(() => normalizePlatform(bad));
  }
});
test("UI no-logs is off by default, existing identities are locked and opening never saves", async (t) => {
  const f = await fixture(t);
  assert.equal(f.doc.getElementById("toggle-noLogs").checked, false);
  assert.equal(f.doc.getElementById("field-accessory-name").readOnly, true);
  assert.equal(f.doc.getElementById("accessory-type").disabled, true);
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.updates.length, 0);
  assert.equal(f.state.saves, 0);
});
test("changing no-logs preserves every switch, unknown option and child bridge field", async (t) => {
  const f = await fixture(t);
  f.input("toggle-noLogs", true, "change");
  await turn();
  assert.deepEqual(f.state.updates.at(-1), [{ ...initial[0], noLogs: true }]);
  assert.equal(f.state.saves, 0);
  assert.equal(f.state.enabled, true);
});
test("sequential preference hides parallel limit while preserving its configured value", async (t) => {
  const f = await fixture(t, [{ ...initial[0], maxConcurrentCommands: 3 }]);
  f.input("toggle-synchronous", true, "change");
  await turn();
  assert.equal(
    f.doc.getElementById("field-global-maxConcurrentCommands").parentElement
      .hidden,
    true,
  );
  assert.equal(f.state.updates.at(-1)[0].maxConcurrentCommands, 3);
  f.input("toggle-synchronous", false, "change");
  await turn();
  assert.equal(
    f.doc.getElementById("field-global-maxConcurrentCommands").parentElement
      .hidden,
    false,
  );
});
test("invalid input disables host Save until corrected", async (t) => {
  const f = await fixture(t);
  f.input("field-accessory-interval", "0");
  await turn();
  assert.equal(f.state.enabled, false);
  assert.equal(f.state.updates.length, 0);
  assert.equal(f.doc.getElementById("settings-error").hidden, false);
  f.input("field-accessory-interval", "15");
  await turn();
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.updates.at(-1)[0].switches[0].interval, 15);
});
test("adding a dimmer requires a name and dimming command; valid configuration reaches host", async (t) => {
  const f = await fixture(t, []);
  f.doc.getElementById("add-accessory").click();
  assert.equal(f.state.enabled, false);
  f.input("field-accessory-name", "New light");
  f.input("accessory-type", "dimmer", "change");
  await turn();
  assert.equal(f.state.enabled, false);
  f.input("field-accessory-dim_cmd", 'lamp "$HB_BRIGHTNESS"');
  await turn();
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.updates.at(-1)[0].name, "cmdSwitch3");
  assert.deepEqual(f.state.updates.at(-1)[0].switches, [
    { name: "New light", dim_cmd: 'lamp "$HB_BRIGHTNESS"' },
  ]);
});
test("duplicate names are rejected, and remove confirmation can be cancelled", async (t) => {
  const f = await fixture(t);
  f.doc.getElementById("add-accessory").click();
  f.input("field-accessory-name", "Office");
  await turn();
  assert.equal(f.state.enabled, false);
  f.input("field-accessory-name", "New switch");
  await turn();
  f.doc.querySelector(".cs-remove > button").click();
  assert.equal(f.doc.querySelector(".cs-remove-confirm").hidden, false);
  f.doc.querySelector(".cs-remove-confirm .btn-link").click();
  assert.equal(f.doc.querySelector(".cs-remove-confirm").hidden, true);
  assert.equal(f.state.updates.at(-1)[0].switches.length, 3);
});
test("removal preserves all remaining command configuration", async (t) => {
  const f = await fixture(t);
  f.doc.querySelector(".cs-remove > button").click();
  f.doc.querySelector(".cs-remove-confirm .btn-danger").click();
  await turn();
  assert.deepEqual(
    f.state.updates.at(-1)[0].switches,
    initial[0].switches.slice(1),
  );
});
test("slow draft updates remain serialized and Save waits for the newest response", async (t) => {
  const resolvers = [];
  const f = await fixture(
    t,
    initial,
    () => new Promise((resolve) => resolvers.push(resolve)),
  );
  f.input("toggle-noLogs", true, "change");
  await turn();
  f.input("toggle-noLogs", false, "change");
  await turn();
  assert.equal(resolvers.length, 1);
  assert.equal(f.state.enabled, false);
  resolvers[0]();
  await turn();
  assert.equal(resolvers.length, 2);
  assert.equal(f.state.enabled, false);
  resolvers[1]();
  await turn();
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.updates.at(-1)[0].noLogs, false);
});
test("failed draft update stays unsaved and a later edit can recover", async (t) => {
  let fail = true;
  const f = await fixture(t, initial, () => {
    if (fail) throw new Error("synthetic failure");
  });
  f.input("toggle-noLogs", true, "change");
  await turn();
  assert.equal(f.state.enabled, false);
  fail = false;
  f.input("toggle-noLogs", false, "change");
  await turn();
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.saves, 0);
});
test("config values are rendered as text and multiple platform blocks are preserved", async (t) => {
  const data = structuredClone(initial);
  data[0].switches[0].name = '<img src=x onerror="alert(1)">';
  data.push({ platform: "cmdSwitch3", name: "Other", switches: [] });
  const f = await fixture(t, data);
  assert.equal(f.doc.querySelector("img"), null);
  f.input("toggle-noLogs", true, "change");
  await turn();
  assert.deepEqual(f.state.updates.at(-1)[1], data[1]);
});

test("editing the existing advanced platform name preserves accessory identities and other platforms", async (t) => {
  const configuration = structuredClone(initial);
  configuration[0].name = "homebridge-cmdswitch2";
  configuration.push({ platform: "cmdSwitch3", name: "Demo", switches: [] });
  const f = await fixture(t, configuration);
  assert.equal(f.doc.querySelectorAll("#field-global-name").length, 1);
  assert.ok(f.doc.getElementById("field-global-name").closest("details"));
  assert.equal(
    f.doc.getElementById("field-global-name").value,
    "homebridge-cmdswitch2",
  );
  f.doc.getElementById("preferences-tab").click();
  f.input("field-global-name", "cmdSwitch3");
  await turn();
  const expected = structuredClone(configuration);
  expected[0].name = "cmdSwitch3";
  assert.deepEqual(f.state.updates.at(-1), expected);
  assert.equal(f.state.saves, 0);
  assert.equal(f.state.enabled, true);
});
