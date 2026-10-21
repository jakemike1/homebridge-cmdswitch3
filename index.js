"use strict";
// Modified 2026-10-21 from luisiam/homebridge-cmdswitch2, with maintained
// command scheduling, validation and Homebridge 2 compatibility fixes.
// Retains name-derived UUIDs and original Switch/Lightbulb service types.
const { normalizePlatform, normalizeSwitch } = require("./config");
const { CommandRunner, failure } = require("./command-runner");
const { SwitchController } = require("./switch-controller");
const PLUGIN = "homebridge-cmdswitch3";
const PLATFORM = "cmdSwitch3";

module.exports = function (homebridge) {
  if (!homebridge.versionGreaterOrEqual("2.0.0"))
    throw new Error("homebridge-cmdswitch3 requires Homebridge 2 or newer");
  const { Service, Characteristic, uuid, HapStatusError, HAPStatus } =
    homebridge.hap;

  class CmdSwitchPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.config = normalizePlatform(config || {});
      this.switches = this.config.switches;
      this.api = api;
      this.accessories = Object.create(null);
      this.controllers = new Map();
      this.bindings = new Map();
      this.closed = false;
      this.runner = new CommandRunner({
        concurrency: this.config.synchronous
          ? 1
          : this.config.maxConcurrentCommands,
      });
      api.on("didFinishLaunching", () => this.didFinishLaunching());
      api.on("shutdown", () => this.dispose());
    }

    configureAccessory(accessory) {
      const name = accessory.context.name;
      if (typeof name !== "string" || Object.hasOwn(this.accessories, name)) {
        throw new Error(
          "Invalid or duplicate cached switch identity; automatic removal refused",
        );
      }
      this.accessories[name] = accessory;
      this.setService(accessory);
    }

    didFinishLaunching() {
      if (this.closed) return;
      // Validate every existing type before registering or removing anything.
      for (const data of this.switches) this.checkType(data);
      for (const data of this.switches) this.addAccessory(data);
      const configured = new Set(this.switches.map((data) => data.name));
      for (const [name, accessory] of Object.entries(this.accessories)) {
        if (!configured.has(name)) this.removeAccessory(accessory);
      }
    }

    routine(message) {
      if (!this.config.noLogs) this.log(message);
    }

    checkType(data) {
      const accessory = this.accessories[data.name];
      if (
        accessory &&
        Boolean(accessory.getService(Service.Lightbulb)) !==
          Boolean(data.dim_cmd)
      )
        throw new Error(
          "Cached accessory type differs from configuration; automatic replacement refused. Restore its dim_cmd setting before restarting.",
        );
    }

    setService(accessory) {
      if (this.bindings.has(accessory)) return;
      const bulb = accessory.getService(Service.Lightbulb);
      const service = bulb || accessory.getService(Service.Switch);
      if (!service || (bulb && accessory.getService(Service.Switch)))
        throw new Error(
          "Cached accessory needs exactly one Switch or Lightbulb service; automatic replacement refused",
        );
      const characteristic = service.getCharacteristic(Characteristic.On);
      const get = () => this.handle(accessory.context, "get");
      const set = (value) => this.handle(accessory.context, "set", value);
      const identify = (_paired, callback) => {
        this.routine(`${accessory.context.name}: identify requested.`);
        callback();
      };
      characteristic.onGet(get).onSet(set);
      const handlers = [{ characteristic, get, set }];
      if (bulb) {
        const characteristic = bulb.getCharacteristic(
          Characteristic.Brightness,
        );
        const get = () => this.handle(accessory.context, "getBrightness");
        const set = (value) =>
          this.handle(accessory.context, "setBrightness", value);
        characteristic.onGet(get).onSet(set);
        handlers.push({ characteristic, get, set });
      }
      accessory.on("identify", identify);
      this.bindings.set(accessory, { handlers, identify });
    }

    unbind(accessory) {
      const binding = this.bindings.get(accessory);
      if (!binding) return;
      for (const { characteristic } of binding.handlers) {
        characteristic.removeOnGet().removeOnSet();
      }
      accessory.removeListener("identify", binding.identify);
      this.bindings.delete(accessory);
    }

    addAccessory(input) {
      if (this.closed) throw failure("CANCELLED", "Platform is closed");
      const data = normalizeSwitch(input);
      this.checkType(data);
      let accessory = this.accessories[data.name];
      const fresh = !accessory;
      if (fresh) {
        accessory = new homebridge.platformAccessory(
          data.name,
          uuid.generate(data.name),
          data.dim_cmd ? 5 : 8,
        );
        accessory.addService(
          data.dim_cmd ? Service.Lightbulb : Service.Switch,
          data.name,
        );
        this.setService(accessory);
        this.accessories[data.name] = accessory;
      }
      this.controllers.get(data.name)?.dispose();
      const context = accessory.context;
      context.name = data.name;
      // Runtime commands belong in config, not the serialized accessory cache.
      for (const field of ["on_cmd", "off_cmd", "dim_cmd", "state_cmd"])
        delete context[field];
      for (const field of [
        "polling",
        "interval",
        "timeout",
        "manufacturer",
        "model",
        "serial",
      ])
        context[field] = data[field];
      const service = accessory.getService(
        data.dim_cmd ? Service.Lightbulb : Service.Switch,
      );
      const characteristic = service.getCharacteristic(Characteristic.On);
      const brightness = data.dim_cmd
        ? service.getCharacteristic(Characteristic.Brightness)
        : null;
      const controller = new SwitchController(
        data,
        context,
        this.runner,
        (value, level) => {
          characteristic.updateValue(value);
          if (brightness)
            brightness.updateValue(value instanceof Error ? value : level);
        },
        (code) => {
          const message = `${data.name}: command failed (${code}).`;
          if (typeof this.log.error === "function") this.log.error(message);
          else this.log(message);
        },
        (message) => this.routine(`${data.name}: ${message}.`),
      );
      this.controllers.set(data.name, controller);
      const info = accessory.getService(Service.AccessoryInformation);
      info
        .setCharacteristic(
          Characteristic.Manufacturer,
          data.manufacturer || "Default-Manufacturer",
        )
        .setCharacteristic(Characteristic.Model, data.model || "Default-Model")
        .setCharacteristic(
          Characteristic.SerialNumber,
          data.serial || "Default-SerialNumber",
        );
      accessory.reachable = true;
      if (fresh)
        this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
      this.routine(
        `${data.name}: ${fresh ? "added" : "restored"} ${data.dim_cmd ? "dimmer" : "switch"}.`,
      );
      controller.publishState();
      controller.start();
      return accessory;
    }

    removeAccessory(accessory) {
      if (!accessory) return;
      const name = accessory.context.name;
      this.controllers.get(name)?.dispose();
      this.controllers.delete(name);
      this.unbind(accessory);
      delete this.accessories[name];
      this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
      this.routine(`${name}: removed.`);
    }

    async handle(context, method, value) {
      const controller = this.controllers.get(context.name);
      try {
        if (!controller)
          throw failure("UNAVAILABLE", "Accessory is unavailable");
        return await controller[method](value);
      } catch (error) {
        throw new HapStatusError(
          error.code === "INVALID_VALUE"
            ? HAPStatus.INVALID_VALUE_IN_REQUEST
            : HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
    }

    dispose() {
      if (this.closed) return;
      this.closed = true;
      for (const controller of this.controllers.values()) controller.dispose();
      for (const accessory of Object.values(this.accessories))
        this.unbind(accessory);
      this.runner.dispose();
    }
  }

  homebridge.registerPlatform(PLUGIN, PLATFORM, CmdSwitchPlatform, true);
};
