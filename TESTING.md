# Testing and release coverage

cmdSwitch3 1.0.0 promotes the beta.6 runtime to stable. Reports from different scripts, dimmers and Homebridge setups remain useful for finding regressions and broadening the coverage described below.

## Start with an isolated setup

Use Homebridge 2 on Linux or macOS with a supported Node version. A fresh instance or separate child bridge is the easiest place to test. Back up before installing. Existing cmdSwitch2 users should read [MIGRATION.md](MIGRATION.md); use an isolated setup for exploratory tests.

Install `homebridge-cmdswitch3@1.0.0` using your usual Homebridge plugin npm prefix, or use `@latest` for the current stable release. The [README](README.md#install) gives the command. The `beta` tag remains on beta.6. For reproducible reports, note the exact installed version rather than just the tag.

This optional configuration exercises the UI and momentary-switch behaviour without contacting a device:

```json
{
  "platform": "cmdSwitch3",
  "name": "Test commands",
  "switches": [
    {
      "name": "cmdSwitch3 test button",
      "on_cmd": "exit 0"
    }
  ]
}
```

After saving and restarting the relevant bridge, switching this button ON should return it to OFF after about one second. It has no background polling and its action does nothing. `exit 0` is a shell builtin on both supported operating systems; unlike `/bin/true`, it does not depend on an executable's location. Remove only this test accessory when finished.

## Useful checks

Run checks only when the resulting device actions are appropriate. Keep routine logging enabled initially; command text and output are intentionally omitted from plugin logs.

| Area                | What to try                                                                    | Expected result                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Switch and state    | ON/OFF, external state change, polling                                         | Home follows the successful action and subsequent state checks.                                                       |
| Dimming             | Set 25%, then 75%; OFF then ON                                                 | The last successful positive brightness returns. A state script prints a plain integer 0–100.                         |
| Sequential commands | Enable Preferences → Sequential commands, then write to two test accessories   | Commands run one at a time in acceptance order.                                                                       |
| Failure handling    | Use a disposable test action with `exit 1`                                     | Home reports failure; the last confirmed state remains. There is no retry.                                            |
| Deadline            | Use a disposable test action with `sleep 15`                                   | The default eight-second action deadline ends the command; later queued actions for that accessory are cancelled.     |
| Quiet logging       | Enable No logs, perform a successful action, then the disposable failure check | Routine plugin messages disappear; errors remain. This does not control logs from other plugins or external services. |
| Settings            | Light/dark theme, narrow screen, edit/save/reopen, invalid values              | Fields remain usable, saved settings return, invalid edits are rejected.                                              |
| Platform name       | Create a fresh configuration; reopen an existing custom-named configuration    | New configurations use `cmdSwitch3`; existing names stay unchanged. Advanced preferences retains the name control.    |
| Restart             | Restart the test bridge after saving valid settings                            | Accessories return with the same identities and without duplicate tiles.                                              |
| Everyday use        | Run normal scenes/automations over several days                                | No unexplained unavailable tiles, missed actions, duplicate commands or growing process counts.                       |

Test artificial failures only on disposable accessories. Do not replace a production action with a diagnostic command. A deliberately passive OFF such as `/bin/true` must remain passive.

## Report a result

Use [GitHub Issues](https://github.com/jakemike1/homebridge-cmdswitch3/issues/new/choose) for bugs and successful test reports. Include:

- Exact plugin, Homebridge, Homebridge UI and Node versions; OS/architecture.
- Fresh install or migration, switch/dimmer, sequential setting and polling interval.
- Steps, expected result, actual result and approximate frequency.
- A small redacted log excerpt and an inert example command that reproduces the problem, if possible.
- For a successful report: which checks passed and how many days it has run.

Never post a full Homebridge config, pairing/cache files, tokens, SSH keys, credentials or commands containing secrets. Replace addresses and personal device names in examples. The plugin has no telemetry, so test reports are voluntary.

## What has been tested

Before publication, beta.1 passed 68 automated tests on each of Node 22.23.3, 24.19.0 and 26.0.0 with real Homebridge 2.4.0 / HAP-NodeJS 2.2.2. Tests use synthetic accessories and harmless local subprocesses. Six original switches and a dimmer preserve UUID/AID/service/characteristic IDs and links across two synthetic cache restorations after explicit ownership transfer.

One Raspberry Pi deployment on Node 24.19.0 / Homebridge 2.4.0 passed 57 runtime/HAP tests, retained six existing switches and pairing records, and passed all 42 readable characteristic checks after migration. The installed settings assets and quiet logging were verified. Physical toggles and controller-side automation execution were not triggered during deployment.

The settings page was browser-tested in desktop, narrow, light and dark layouts using Homebridge UI 5.28.0 assets and a synthetic host. A source-less MutationObserver console diagnostic was observed; no functional UI failure was reproduced, and its origin is unconfirmed. Live browser interaction across other Homebridge UI versions needs testing.

Beta.2 changes release metadata, documentation and development/release tooling. Its packaged runtime and settings assets are unchanged from beta.1. CI runs the automated suite on Linux and macOS with Node 22, 24 and 26. Hardware dimming, larger installations, diverse command scripts and prolonged operation remain the main gaps.

### Beta.3

The verification-readiness changes add regression coverage for malformed configuration/cache, missing versus empty switch lists, startup and background publication failures, safe shutdown order and command stream errors. Tests retain synthetic accessory identities and verify that commands and raw error details are not logged. All 77 tests and the packed-install check pass locally on macOS arm64 with Node 22.23.3, 24.19.0 and 26.0.0. The maintainer's Pi remains on the earlier runtime; beta.3 has not been deployed there.

Run `npm run build`, `npm run format:check` and `npm run test:package`. The last check installs the exact tarball offline into a disposable directory, checks its bytes and absence of install hooks/runtime dependencies, and tests real Homebridge API startup and harmless HAP writes without advertising a bridge. CI runs it on both supported operating systems. Check the exact release commit's [CI results](https://github.com/jakemike1/homebridge-cmdswitch3/actions) alongside the release notes; local macOS results alone do not establish Linux compatibility.

### Beta.4

Beta.4 changes npm search metadata and release documentation only. Its runtime, settings UI, configuration schema and dependencies are identical to beta.3. CI covers Linux x64, Linux ARM64 and macOS on Node 22, 24 and 26; see the exact release commit's results linked from its GitHub prerelease. No beta.4 deployment to the maintainer's Pi has been performed.

### Beta.5

Beta.5 adds SSH documentation, settings help and discovery metadata. The runtime modules, schema validation/defaults and dependencies are unchanged from beta.4. All 77 tests and the packed-install check pass locally on Node 26/macOS ARM64. CI runs the same checks across Linux x64, native Linux ARM64 and macOS on Node 22, 24 and 26; see the exact release commit's results linked from its GitHub prerelease.

### Beta.6

Beta.6 updates the settings theme and the default platform name for newly created configurations. The 78-test suite covers the new default, preservation of existing names, and edits to the single Advanced preferences name field without changing accessories, child-bridge configuration or other platform blocks. Command execution modules, validation rules, dependencies and accessory identity generation are unchanged from beta.5.

The theme was inspected in desktop light/dark and narrow layouts using official Homebridge UI 5.29.0 assets and its client bridge, with a synthetic host that mirrors the real iframe theme classes. The dark accessory pane is darker than the surrounding canvas; the editor matches that canvas. The selected host accent is used for selection, tabs and controls. The previously observed source-less MutationObserver diagnostic remains unconfirmed; no failed UI interaction was reproduced. Test other Homebridge colour themes and real-host UI versions when reporting results.

At beta.6 publication, the maintainer's Pi remained on beta.5. The maintainer subsequently confirmed beta.6 installed and working through a Homebridge UI screenshot and normal use. CI results for the beta.6 commit are linked from its GitHub prerelease and cover all nine OS/Node combinations.

For the beta.5 documentation checks, the three README JSON examples passed schema/runtime validation, four shell examples parsed, and eight mocked status-helper cases covered ON, OFF, unknown/empty output and command failures. The expanded help was checked in desktop light, narrow light and narrow dark layouts with a synthetic settings host. Those checks executed no remote SSH commands or device actions. Test your SSH alias, key permissions and remote status convention as the Homebridge service account before configuring real actions.

### Stable 1.0.0

The maintainer approved 1.0.0 after successful everyday use of beta.6, including switches and automations calling separate local heating and hot-water helpers. Recent physical tests confirmed the intended outputs turning on and off through cmdSwitch3. This is evidence from one Raspberry Pi installation; it does not establish physical dimmer coverage, universal migration safety or the safety of every user-supplied command helper.

Stable 1.0.0 changes version/publishing metadata and documentation only. Runtime modules, settings assets, schema, dependencies and identity generation remain identical to beta.6. The release requires the 78-test suite, formatting, syntax/shared-validator checks and offline packed-install/HAP checks on the exact release commit. See the CI links in the [1.0.0 release notes](https://github.com/jakemike1/homebridge-cmdswitch3/releases/tag/v1.0.0). Local macOS checks alone do not establish all supported platforms. No Pi deployment, restart or device command is part of publication.

## Remaining coverage and future releases

The earlier beta guidance aimed for at least two weeks of normal use on the final candidate and successful switch/dimmer/sequential tests on more than one installation. Broader physical dimming, sequential use on multiple installations and diverse command scripts remain coverage gaps. The maintainer accepted those limitations for 1.0.0 based on the automated checks and confirmed everyday switch use; this is not a claim that every original testing target was completed.

For future releases, require no unresolved pairing, command-failure or state-consistency regressions. Changes affecting runtime behaviour need fresh observation and targeted tests. Calendar time alone is not a release criterion. Homebridge verification remains a separate review and has not yet been approved.
