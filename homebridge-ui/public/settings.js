"use strict";
(() => {
  const hb = window.homebridge;
  const byId = (id) => document.getElementById(id);
  const originalItems = new WeakSet(),
    types = new WeakMap();
  let blocks,
    config,
    selected = 0,
    revision = 0,
    updates = Promise.resolve(),
    schema;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, className, action) => {
    const node = element("button", text, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };
  const isDimmer = (item) =>
    (types.get(item) || (item.dim_cmd ? "dimmer" : "switch")) === "dimmer";
  function showError(message) {
    byId("settings-error").textContent = message;
    byId("settings-error").hidden = !message;
  }
  function validate() {
    window.CmdSwitchConfig.normalizePlatform(config);
    for (const item of config.switches) {
      if (isDimmer(item) && !item.dim_cmd?.trim())
        throw new Error("Add a dimming command for your dimmer.");
      if (item.polling && !item.state_cmd?.trim())
        throw new Error("Add a state command before enabling polling.");
    }
  }
  function change() {
    const current = ++revision;
    hb.disableSaveButton();
    try {
      validate();
    } catch (error) {
      showError(error.message);
      byId("draft-status").textContent =
        "Resolve the settings error before saving.";
      return;
    }
    showError("");
    byId("draft-status").textContent = "Updating draft…";
    const snapshot = structuredClone(blocks);
    // Serialize updates so slower responses cannot put an older draft last.
    updates = updates
      .catch(() => {})
      .then(() => hb.updatePluginConfig(snapshot))
      .then(() => {
        if (current !== revision) return;
        hb.enableSaveButton();
        byId("draft-status").textContent =
          "Changes ready. Use Save below to apply.";
      })
      .catch(() => {
        if (current !== revision) return;
        showError(
          "Could not update the settings draft. Edit a field to try again.",
        );
        byId("draft-status").textContent = "Changes have not been applied.";
      });
  }
  function field(target, key, definition, options = {}) {
    const wrapper = element("div", undefined, "cs-field");
    const id = `field-${options.global ? "global" : "accessory"}-${key}`;
    const label = element("label", options.title || definition.title || key);
    label.htmlFor = id;
    const input = element(
      options.command ? "textarea" : "input",
      undefined,
      "form-control",
    );
    input.id = id;
    input.name = key;
    const numeric = definition.type === "integer";
    if (!options.command) input.type = numeric ? "number" : "text";
    if (numeric) {
      input.min = definition.minimum;
      input.max = definition.maximum;
      input.step = "1";
    }
    if (definition.maxLength) input.maxLength = definition.maxLength;
    if (definition.pattern) input.pattern = definition.pattern;
    if (key === "name" && !options.global) input.required = true;
    input.value = target[key] ?? definition.default ?? "";
    input.readOnly = !!options.readonly;
    input.spellcheck = false;
    if (options.command) {
      input.rows = 2;
      input.autocomplete = "off";
      input.autocapitalize = "off";
    }
    const help = element(
      "div",
      options.help || definition.description || "",
      "cs-help",
    );
    help.id = `${id}-help`;
    input.setAttribute("aria-describedby", help.id);
    input.addEventListener("input", () => {
      input.setAttribute("aria-invalid", String(!input.checkValidity()));
      input.classList.toggle("is-invalid", !input.checkValidity());
      if (input.value === "") delete target[key];
      else target[key] = numeric ? Number(input.value) : input.value;
      if (key === "name" || key === "polling" || key === "interval")
        renderList();
      change();
    });
    wrapper.append(label, input, help);
    return wrapper;
  }
  function toggle(target, key, title, description, after) {
    const wrapper = element("div", undefined, "cs-toggle form-switch");
    const text = element("div"),
      id = `toggle-${key}`;
    const label = element("label", title);
    label.htmlFor = id;
    const help = element("div", description, "cs-help");
    help.id = `${id}-help`;
    text.append(label, help);
    const input = element("input", undefined, "form-check-input");
    input.type = "checkbox";
    input.role = "switch";
    input.id = id;
    input.checked = target[key] === true;
    input.setAttribute("aria-describedby", help.id);
    input.addEventListener("change", () => {
      target[key] = input.checked;
      after?.();
      change();
    });
    wrapper.append(text, input);
    return wrapper;
  }
  function disclosure(title, children) {
    const node = element("details", undefined, "cs-details");
    const content = element("div");
    content.append(...children);
    node.append(element("summary", title), content);
    return node;
  }
  function renderList() {
    const list = byId("accessory-list");
    list.replaceChildren();
    byId("accessory-count").textContent = config.switches.length;
    byId("add-accessory").disabled = config.switches.length >= 128;
    config.switches.forEach((item, index) => {
      const row = button("", "cs-accessory", () => {
        selected = index;
        renderList();
        renderEditor();
      });
      row.setAttribute("aria-current", String(index === selected));
      const text = element("span");
      text.append(
        element("strong", item.name || "New accessory"),
        element(
          "small",
          `${isDimmer(item) ? "Dimmer" : "Switch"}${item.polling ? ` · Every ${item.interval || 1}s` : ""}`,
        ),
      );
      row.append(text);
      list.append(row);
    });
    if (!config.switches.length)
      list.append(element("p", "No accessories yet", "cs-help"));
  }
  function renderEditor() {
    const host = byId("accessory-editor");
    host.replaceChildren();
    const item = config.switches[selected];
    if (!item) {
      const empty = element("div", undefined, "cs-empty");
      empty.append(
        element("h2", "Start with one command"),
        element("p", "Add a switch or a dimmer to bring it into Apple Home."),
      );
      host.append(empty);
      return;
    }
    const dimmer = isDimmer(item),
      saved = originalItems.has(item);
    const header = element("div", undefined, "cs-editor-header"),
      title = element("div");
    title.append(
      element("h2", item.name || "New accessory"),
      element("p", "Set up its commands and state checks.", "cs-help"),
    );
    header.append(
      title,
      element("span", dimmer ? "DIMMER" : "SWITCH", "cs-badge"),
    );
    host.append(header);
    const form = element("form");
    form.noValidate = true;
    form.addEventListener("submit", (event) => event.preventDefault());
    const definitions = schema.schema.properties.switches.items.properties;
    const identity = element("div", undefined, "cs-grid");
    identity.append(
      field(item, "name", definitions.name, {
        readonly: saved,
        help: saved
          ? "Fixed to preserve Home automations. Rename the tile in Apple Home."
          : "Choose a unique name. This becomes its HomeKit identity.",
      }),
    );
    const kind = element("div", undefined, "cs-field"),
      label = element("label", "Accessory type");
    label.htmlFor = "accessory-type";
    const select = element("select", undefined, "form-select");
    select.id = "accessory-type";
    select.disabled = saved;
    for (const [value, text] of [
      ["switch", "Switch"],
      ["dimmer", "Dimmable light"],
    ]) {
      const option = element("option", text);
      option.value = value;
      select.append(option);
    }
    select.value = dimmer ? "dimmer" : "switch";
    select.addEventListener("change", () => {
      types.set(item, select.value);
      if (select.value === "switch") delete item.dim_cmd;
      renderList();
      renderEditor();
      change();
      byId("accessory-type").focus();
    });
    kind.append(
      label,
      select,
      element(
        "div",
        saved
          ? "Saved types stay fixed to protect HomeKit services."
          : "A dimmable light adds a brightness slider.",
        "cs-help",
      ),
    );
    identity.append(kind);
    form.append(identity);
    if (dimmer)
      form.append(
        field(item, "dim_cmd", definitions.dim_cmd, {
          command: true,
          title: "Dimming command",
          help: "Run a local script or SSH command with $HB_BRIGHTNESS. ON restores the last nonzero level.",
        }),
      );
    else
      form.append(
        field(item, "on_cmd", definitions.on_cmd, {
          command: true,
          title: "Turn on",
          help: "Local shell or SSH command. Exit 0 only when the ON action succeeds.",
        }),
      );
    form.append(
      field(item, "off_cmd", definitions.off_cmd, {
        command: true,
        title: "Turn off",
        help: dimmer
          ? "Optional. When empty, the dimming command runs with brightness 0."
          : "Local shell or SSH command. For a momentary action, leave OFF and state commands empty.",
      }),
    );
    form.append(
      disclosure("SSH examples & status", [
        element(
          "p",
          "Configure SSH for the Homebridge service account, including its host alias, key and verified known_hosts entry. Use BatchMode yes and StrictHostKeyChecking yes for unattended commands.",
          "cs-help",
        ),
        element(
          "p",
          dimmer
            ? 'Dimmer example: ssh -n homebridge-device "/usr/local/bin/lamp dim $HB_BRIGHTNESS"'
            : "ON example: ssh -n homebridge-device /usr/local/bin/device-power on",
          "cs-help",
        ),
        element(
          "p",
          dimmer
            ? "The local shell expands $HB_BRIGHTNESS. The remote brightness check must exit 0 and print an integer 0–100, where 0 means OFF. Return an error code greater than 1 when the level is unknown."
            : "Use device-power off for OFF. For Check state, use ssh -n homebridge-device /usr/local/bin/device-power-state. The helper must exit 0 for ON, 1 for OFF and 2 or greater for an error.",
          "cs-help",
        ),
        element(
          "p",
          "Enable Advanced → Strict state checks for that status contract. SSH errors normally exit 255; strict checks report them as failures and retain the last known state. A helper error returned as 1 would still mean OFF.",
          "cs-help",
        ),
        element(
          "p",
          "These hosts and scripts are placeholders to adapt. Actions must return 0 only on success. Preserve failure codes with && when chaining commands. See the README for setup, status-helper and momentary-action examples; opening this help runs no commands.",
          "cs-help",
        ),
      ]),
      disclosure("State & polling", [
        field(item, "state_cmd", definitions.state_cmd, {
          command: true,
          title: "Check state",
          help: dimmer
            ? "Print an integer 0–100 and exit 0. Zero means off. For SSH errors, see Strict state checks in Advanced."
            : "Exit 0 means ON; nonzero means OFF by default. For SSH, use 1 only for confirmed OFF and enable Strict state checks in Advanced. Leave empty to use the last successful action.",
        }),
        toggle(
          item,
          "polling",
          "Check state automatically",
          "Keep Apple Home up to date in the background. Checks never overlap.",
          () => renderList(),
        ),
        field(item, "interval", definitions.interval, {
          title: "Seconds between checks",
        }),
      ]),
    );
    const advanced = [
      "timeout",
      "commandTimeout",
      "stateTimeout",
      "queueLimit",
      "strictState",
    ];
    const advancedFields = advanced
      .filter((key) => key !== "strictState")
      .map((key) => field(item, key, definitions[key]));
    if (dimmer)
      advancedFields.unshift(field(item, "brightness", definitions.brightness));
    advancedFields.push(
      toggle(
        item,
        "strictState",
        "Strict state checks",
        "Recommended for SSH status helpers: 0 means ON (or a dimmer reading), 1 means OFF, other codes mean error. Failures retain the previous state. Your helper must reserve exit 1 for confirmed OFF.",
      ),
    );
    form.append(
      disclosure("Advanced", advancedFields),
      disclosure(
        "Accessory information",
        ["manufacturer", "model", "serial"].map((key) =>
          field(item, key, definitions[key]),
        ),
      ),
    );
    const remove = element("div", undefined, "cs-remove");
    const confirm = element("div", undefined, "cs-remove-confirm");
    confirm.hidden = true;
    confirm.append(
      element(
        "p",
        "Removing this accessory takes it out of Homebridge after you save and restart. Home scenes and automations using it may need repair.",
      ),
    );
    confirm.append(
      button("Remove accessory", "btn btn-danger btn-sm", () => {
        config.switches.splice(selected, 1);
        selected = Math.max(0, selected - 1);
        renderList();
        renderEditor();
        change();
        byId("add-accessory").focus();
      }),
      button("Keep accessory", "btn btn-link btn-sm", () => {
        confirm.hidden = true;
        removeButton.focus();
      }),
    );
    const removeButton = button(
      "Remove accessory…",
      "btn btn-link text-danger p-0",
      () => {
        confirm.hidden = false;
        confirm.querySelector("button").focus();
      },
    );
    remove.append(removeButton, confirm);
    form.append(remove);
    host.append(form);
  }
  function renderPreferences() {
    const form = byId("preferences-form");
    form.replaceChildren();
    form.addEventListener("submit", (event) => event.preventDefault());
    const definitions = schema.schema.properties;
    const parallel = field(
      config,
      "maxConcurrentCommands",
      definitions.maxConcurrentCommands,
      { global: true },
    );
    parallel.hidden = config.synchronous === true;
    form.append(
      toggle(
        config,
        "noLogs",
        "No logs",
        "Keep routine messages quiet. Command failures still appear in the Homebridge log.",
      ),
    );
    form.append(
      toggle(
        config,
        "synchronous",
        "Sequential commands",
        "Run one command at a time across all accessories, in order. State checks join the same queue.",
        () => {
          parallel.hidden = config.synchronous === true;
        },
      ),
    );
    form.append(
      disclosure("Advanced preferences", [
        field(config, "name", definitions.name, {
          global: true,
          title: "Platform name",
        }),
        parallel,
      ]),
    );
  }
  function showView(view) {
    for (const name of ["accessories", "preferences"]) {
      byId(`${name}-view`).hidden = name !== view;
      byId(`${name}-tab`).setAttribute("aria-pressed", String(name === view));
    }
  }
  async function initialize() {
    hb.disableSaveButton();
    try {
      [blocks, schema] = await Promise.all([
        hb.getPluginConfig(),
        hb.getPluginConfigSchema(),
      ]);
      blocks = structuredClone(blocks);
      if (!Array.isArray(blocks))
        throw new Error("Invalid plugin configuration");
      if (!blocks.length)
        blocks.push({
          platform: "cmdSwitch3",
          name: "cmdSwitch3",
          switches: [],
        });
      config = blocks[0];
      config.switches ??= [];
      window.CmdSwitchConfig.normalizePlatform(config);
      for (const item of config.switches) originalItems.add(item);
      const mode = await hb.userCurrentLightingMode();
      document.documentElement.dataset.bsTheme = mode;
      // Homebridge mirrors its selected theme class into this iframe. Use its
      // accent rather than Bootstrap's unrelated default blue.
      const accent = element("span", "", "primary-text");
      document.body.append(accent);
      const color = getComputedStyle(accent).color;
      accent.remove();
      if (color)
        byId("cmdswitch-settings").style.setProperty("--cs-accent", color);
      byId("loading").hidden = true;
      byId("accessories-tab").addEventListener("click", () =>
        showView("accessories"),
      );
      byId("preferences-tab").addEventListener("click", () =>
        showView("preferences"),
      );
      byId("add-accessory").addEventListener("click", () => {
        config.switches.push({ name: "" });
        selected = config.switches.length - 1;
        renderList();
        renderEditor();
        change();
        byId("field-accessory-name").focus();
      });
      renderList();
      renderEditor();
      renderPreferences();
      showView("accessories");
      validate();
      hb.enableSaveButton();
      byId("draft-status").textContent =
        "Changes apply when you save and restart.";
    } catch {
      byId("loading").hidden = true;
      showError(
        "Could not load settings. Check the plugin configuration, then reopen this page.",
      );
      byId("draft-status").textContent = "Settings are unchanged.";
    }
  }
  hb.addEventListener("ready", initialize, { once: true });
})();
