"use strict";
// Exercise the actual distributable offline, without installing globally,
// opening a HomeKit listener or reading any real Homebridge configuration.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "cmdswitch3-package-"));
const manifest = require(join(root, "package.json"));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run test:package");

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

try {
  const [packed] = JSON.parse(
    run([
      npm,
      "pack",
      "--offline",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      scratch,
    ]),
  );
  const files = packed.files.map((file) => file.path);
  for (const required of [
    "index.js",
    "config.js",
    "command-runner.js",
    "switch-controller.js",
    "config.schema.json",
    "LICENSE",
    "NOTICE",
    "homebridge-ui/public/index.html",
    "homebridge-ui/public/validation.js",
    "homebridge-ui/public/settings.js",
    "homebridge-ui/public/settings.css",
  ])
    assert.ok(files.includes(required), `Missing packed file: ${required}`);
  assert.ok(
    files.every(
      (file) => !/^(test|scripts|node_modules|\.github|docs)\//.test(file),
    ),
  );
  const prefix = join(scratch, "install");
  run([
    npm,
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    prefix,
    join(scratch, packed.filename),
  ]);
  const installed = join(prefix, "node_modules", manifest.name);
  for (const file of files)
    assert.deepEqual(
      readFileSync(join(installed, file)),
      readFileSync(join(root, file)),
      `Packed bytes differ: ${file}`,
    );
  const installedManifest = JSON.parse(
    readFileSync(join(installed, "package.json")),
  );
  assert.equal(installedManifest.version, manifest.version);
  assert.deepEqual(installedManifest.dependencies || {}, {});
  assert.deepEqual(installedManifest.optionalDependencies || {}, {});
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"])
    assert.equal(installedManifest.scripts?.[lifecycle], undefined);

  const storage = join(scratch, "storage");
  mkdirSync(storage);
  const hbPath = dirname(dirname(require.resolve("homebridge")));
  const probe = `
    import assert from "node:assert/strict";
    import { readdirSync } from "node:fs";
    import { createRequire } from "node:module";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const [installed, hbPath, storage] = process.argv.slice(1);
    const require = createRequire(join(installed, "package.json"));
    const { HomebridgeAPI } = await import(pathToFileURL(join(hbPath, "dist/api.js")));
    const { User } = await import(pathToFileURL(join(hbPath, "dist/user.js")));
    User.setStoragePath(storage);
    assert.ok(!process.stdin.isTTY);
    let Platform;
    const api = new HomebridgeAPI();
    api.on("registerPlatform", (alias, type, plugin) => {
      assert.equal(alias, "cmdSwitch3");
      assert.equal(plugin, "homebridge-cmdswitch3");
      Platform = type;
    });
    const registered = [];
    api.on("registerPlatformAccessories", (list) => registered.push(...list));
    api.on("unregisterPlatformAccessories", () => assert.fail("Unexpected removal"));
    require(installed)(api);
    assert.equal(typeof Platform, "function");
    const messages = [];
    const inactive = [undefined, null, {}, { platform: "cmdSwitch3" }].map(config => new Platform(message => messages.push(message), config, api));
    api.signalFinished();
    for (const platform of inactive) {
      assert.equal(HomebridgeAPI.isDynamicPlatformPlugin(platform), true);
      assert.equal(platform.runner, undefined);
      assert.equal(platform.controllers.size, 0);
    }
    assert.equal(registered.length, 0);
    assert.deepEqual(messages, []);
    // A configured harmless command is exercised via real Homebridge/HAP API.
    const active = new Platform(message => messages.push(message), {
      switches: [{ name: "Package test", on_cmd: "exit 0", off_cmd: "exit 0" }]
    }, api);
    api.signalFinished();
    assert.equal(registered.length, 1);
    const on = registered[0].getService(api.hap.Service.Switch).getCharacteristic(api.hap.Characteristic.On);
    await on.handleSetRequest(true).catch(error => {
      console.error("Packed HAP write failed:", error, messages);
      throw error;
    });
    assert.equal(await on.handleGetRequest(), true);
    await on.handleSetRequest(false);
    assert.equal(await on.handleGetRequest(), false);
    api.signalShutdown();
    assert.equal(active.closed, true);
    assert.deepEqual(readdirSync(storage), []);
    console.log("Packed install: real Homebridge registration, inactive without config, no TTY, harmless HAP writes, clean shutdown, no storage files");
  `;
  process.stdout.write(
    run(
      ["--input-type=module", "-e", probe, installed, hbPath, storage],
      scratch,
    ),
  );
  console.log(
    `Package smoke passed: ${manifest.version}, ${files.length} files, ${process.version}, ${process.platform}/${process.arch}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
