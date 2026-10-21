# homebridge-cmdswitch3

Command switches and dimmable lights for **Homebridge 2**. A maintained successor built from [luisiam/homebridge-cmdswitch2](https://github.com/luisiam/homebridge-cmdswitch2), with a tidy settings page, optional quiet logging and bounded command execution.

**Public beta: 1.0.0-beta.2.** Testers are welcome. Start with a fresh or isolated installation and follow [TESTING.md](TESTING.md). Existing cmdSwitch2 installations need a deliberate migration: read [MIGRATION.md](MIGRATION.md) before changing anything.

## Install the beta

From your Homebridge terminal, using the same npm installation/prefix as your existing plugins:

```sh
npm install -g homebridge-cmdswitch3@beta
```

The explicit `@beta` tag selects the testing release. This is not a stable release and does not automatically replace cmdSwitch2. Restart Homebridge after the first installation so it discovers the new plugin. Configure **cmdSwitch3** in Homebridge UI, preferably on its own child bridge for a fresh setup.

[Report a bug or share test results](https://github.com/jakemike1/homebridge-cmdswitch3/issues/new/choose) · [Release notes](CHANGELOG.md)

## What is included

- Original switches, momentary switches, dimming through `dim_cmd` and `$HB_BRIGHTNESS`, and `synchronous` sequential execution.
- A custom Homebridge settings page: accessory list, command editor, collapsible state/advanced settings, and a Preferences view. It follows Homebridge's theme and adapts to narrow screens.
- **No logs**, off by default, silences routine initialization, identification, state-change and successful-action messages. Errors remain visible. Command text, stdout and stderr are never logged.
- Real execution deadlines, bounded queues, shared state reads, completion-based polling, stale-result protection and shutdown cleanup.
- Successful commands may write to stderr. Exit status determines success. Failed writes reach HomeKit as errors and do not overwrite the last confirmed state.
- Modern promise-based HomeKit handlers. Homebridge 1 support, the old configuration wizard and the unbounded `ExecQueue` are removed.
- No runtime npm dependencies and no additional UI server process.

## Requirements

Homebridge 2.x, Node 22, 24 or 26, and Linux or macOS. Use a Node version supported by your Homebridge installation. Windows and Homebridge 1 are unsupported.

I tested the runtime against Homebridge 2.4.0 / HAP-NodeJS 2.2.2 on Node 22.23.3, 24.19.0 and 26.0.0, with 68 automated tests passing on each. One Raspberry Pi installation now runs the same runtime from the private beta.1 build: six migrated switches retained their HomeKit identities and pairing data, and all 42 readable characteristics passed. This is early validation, not a guarantee for other installations. Physical dimming and controller-side automation execution still need broader testing. [Testing coverage and limitations](TESTING.md#what-has-been-tested) explain the evidence.

## Settings

Open the plugin's **Settings** page in Homebridge UI. Add an accessory, choose **Switch** or **Dimmable light**, and enter its commands. Use **Preferences** for No logs and Sequential commands. Edits update Homebridge's draft; the normal host **Save** button persists them. Restart the affected child bridge to apply changes.

Existing accessory names and types are locked in the custom editor to preserve their identities. Rename their visible tiles in Apple Home. Removing an accessory requires a confirmation in the editor. The runtime refuses to silently replace a cached switch with a lightbulb or vice versa.

Unknown configuration fields and existing child-bridge settings survive edits. The JSON schema is also included for validation and standard tooling. Editing settings never executes a device command.

### Example

These are placeholder script paths, not supplied device integrations:

```json
{
  "platform": "cmdSwitch3",
  "name": "Command Switches",
  "noLogs": false,
  "synchronous": false,
  "switches": [
    {
      "name": "Desk power",
      "on_cmd": "/usr/local/bin/desk-power on",
      "off_cmd": "/usr/local/bin/desk-power off",
      "state_cmd": "/usr/local/bin/desk-power status",
      "polling": true,
      "interval": 10
    },
    {
      "name": "Reading lamp",
      "dim_cmd": "/usr/local/bin/lamp dim \"$HB_BRIGHTNESS\"",
      "state_cmd": "/usr/local/bin/lamp brightness",
      "brightness": 60
    }
  ]
}
```

### Commands and brightness

Commands run in the system shell as the Homebridge service user, inheriting its environment. Keep scripts and credentials outside this package. Grant only the permissions your commands need.

For a switch, `state_cmd` exit 0 means ON and any nonzero exit means OFF. Enable `strictState` to accept only exit 0 (ON) and 1 (OFF), reporting other codes as errors. A state-read timeout, signal or output overflow is always an error and retains the previous state.

For a dimmer, a successful `state_cmd` must print only an integer **0–100**, with optional surrounding whitespace. Zero means OFF. Invalid output is an error. A nonzero exit follows the same OFF/strict-state rules. Both On and Brightness share this one state check.

A brightness write runs `dim_cmd` with `HB_BRIGHTNESS` set to the requested percentage. ON restores the last successful nonzero level using `dim_cmd`; it does not run `on_cmd`. OFF runs `off_cmd` if configured, otherwise `dim_cmd` with level 0. OFF preserves the remembered level for the next ON. Fresh dimmers default to 100%; a configured initial level is used only when no valid cached brightness exists. An initial zero has a 100% ON fallback.

For a switch with one action and no state command, the opposite direction is a passive reset. After a successful action it resets after one second without executing an undefined command. Dimmers do not momentarily reset. A missing action on a state-backed switch is reported as an error.

### Timing and ordering

| Setting                 | Default | Meaning                                                                                                                |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `synchronous`           | `false` | One command at a time across this platform, in acceptance order, including checks and dimmers.                         |
| `maxConcurrentCommands` | `4`     | Parallel command limit, 1–16. Ignored in sequential mode.                                                              |
| `polling`               | `false` | Background state checks; startup still reads a configured state command.                                               |
| `interval`              | `1`     | Seconds after the previous poll finishes, 1–86400.                                                                     |
| `timeout`               | `1`     | Post-action state refresh delay in seconds, 0–60. Retained configuration key; never acknowledges an unfinished action. |
| `commandTimeout`        | `8`     | Action deadline including queue wait, 1–8 seconds.                                                                     |
| `stateTimeout`          | `5`     | State-check deadline including queue wait, 1–8 seconds.                                                                |
| `queueLimit`            | `8`     | Maximum outstanding actions per accessory, 1–64.                                                                       |
| `strictState`           | `false` | Report state-command exits other than 0/1 as failures.                                                                 |

Commands for one accessory are always serialized. State reads never overlap that accessory's actions. Sequential mode also preserves the order of successive writes across different accessories. A failed action cancels later queued actions for that accessory, without retrying them; other accessories can continue. Global pending commands are limited to 128. Queues are not persisted across restart.

On POSIX systems, deadlines cancel the process group with TERM followed by KILL after a 250 ms grace period. Output is limited to 1 MiB per stream. Only dimmer state checks retain stdout long enough to parse the number. Long-running work should be handled by a supervised service whose start/stop command returns promptly and truthfully.

The plugin can only act on a shell's final exit status. Use `first-command && second-command` when the second step should happen only after success. `first-command; second-command` can hide a failure. This package does not install device-specific helpers. A deliberately harmless OFF command such as `/bin/true` remains harmless.

## Development and local build

```sh
npm ci --ignore-scripts
npm run build
npm run format:check
npm pack --ignore-scripts
```

`build` runs syntax/shared-validator checks and the test suite. `build:ui` regenerates the browser validator from the runtime validator after changes to `config.js`. `publishConfig.tag` defaults publication to `beta`; stable releases require an explicit release decision. The tarball contains only runtime files, UI assets and documentation, excluding tests, preview fixtures and development dependencies.

For a browser preview, extract the official `homebridge-config-ui-x@5.28.0` npm package into a temporary directory and set `HOMEBRIDGE_UI_PATH` to its `package` directory, then run `npm run preview`. It binds only to `127.0.0.1:43183`, uses example accessories, and does not start Homebridge or execute configured commands. Its Save button affects only the preview's in-memory draft. The same packaged settings HTML/CSS/JS runs inside the real Homebridge UI bridge.

## Origin and licence

The Git history starts at the original repository; this work branches from commit `c3b293e569053ea427f84ab01bc66e190ef905c7`. The original Apache-2.0 `LICENSE` is retained byte-for-byte. Attribution and changes are recorded in [NOTICE](NOTICE).

The original and downstream manifests historically said ISC despite shipping the Apache-2.0 licence. This successor uses Apache-2.0 to match the continuously shipped licence file; the historical metadata discrepancy does not establish the original author's intent. No endorsement by the original author is implied.
