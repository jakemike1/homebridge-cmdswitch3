"use strict";
const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
for (const file of readdirSync(".").filter((name) => name.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(1);
}
