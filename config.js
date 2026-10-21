"use strict";

function integer(value, fallback, min, max, label) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error(`${label} must be an integer`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function normalizeSwitch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid switch configuration");
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 128
  ) {
    throw new Error(
      "Each switch needs a nonempty name of at most 128 characters",
    );
  }
  // Do not trim/rename: legacy UUIDs are generated from the exact name.
  const result = { ...input };
  for (const field of ["on_cmd", "off_cmd", "dim_cmd", "state_cmd"]) {
    if (input[field] === undefined || input[field] === "") delete result[field];
    else if (
      typeof input[field] !== "string" ||
      !input[field].trim() ||
      input[field].length > 32768
    ) {
      throw new Error(
        `${field} must be a nonempty command string of at most 32768 characters`,
      );
    }
  }
  for (const field of ["polling", "strictState"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean")
      throw new Error(`${field} must be a boolean`);
    result[field] = input[field] === true;
  }
  result.brightness = integer(input.brightness, 100, 0, 100, "brightness");
  result.interval = integer(input.interval, 1, 1, 86400, "interval");
  // Preserve the old field as the refresh delay. It was never an execution limit.
  result.timeout = integer(input.timeout, 1, 0, 60, "timeout (refresh delay)");
  result.commandTimeout = integer(
    input.commandTimeout,
    8,
    1,
    8,
    "commandTimeout",
  );
  result.stateTimeout = integer(input.stateTimeout, 5, 1, 8, "stateTimeout");
  result.queueLimit = integer(input.queueLimit, 8, 1, 64, "queueLimit");
  for (const field of ["manufacturer", "model", "serial"]) {
    if (
      input[field] !== undefined &&
      typeof input[field] !== "string" &&
      typeof input[field] !== "number"
    ) {
      throw new Error(`${field} must be a string or number`);
    }
    if (input[field] !== undefined) result[field] = String(input[field]);
  }
  return result;
}

function normalizePlatform(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Invalid platform configuration");
  const list = config.switches === undefined ? [] : config.switches;
  if (!Array.isArray(list) || list.length > 128)
    throw new Error("switches must be an array of at most 128 switches");
  const switches = list.map(normalizeSwitch);
  const names = new Set();
  for (const item of switches) {
    if (names.has(item.name))
      throw new Error("Duplicate switch name; accessory names must be unique");
    names.add(item.name);
  }
  for (const field of ["synchronous", "noLogs"]) {
    if (config[field] !== undefined && typeof config[field] !== "boolean")
      throw new Error(`${field} must be a boolean`);
  }
  return {
    ...config,
    synchronous: config.synchronous === true,
    noLogs: config.noLogs === true,
    switches,
    maxConcurrentCommands: integer(
      config.maxConcurrentCommands,
      4,
      1,
      16,
      "maxConcurrentCommands",
    ),
  };
}

module.exports = { integer, normalizeSwitch, normalizePlatform };
