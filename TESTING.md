# Testing the public beta

Thank you for helping test cmdSwitch3. Reports from different scripts, dimmers and Homebridge setups will help decide when 1.0.0 is ready.

## Start with an isolated setup

Use Homebridge 2 on Linux or macOS with a supported Node version. A fresh instance or separate child bridge is the easiest place to test. Back up before installing. Existing cmdSwitch2 users should read [MIGRATION.md](MIGRATION.md); do not replace a working platform just to try the beta.

Install `homebridge-cmdswitch3@beta` using your usual Homebridge plugin npm prefix. The [README](README.md#install-the-beta) gives the command. For reproducible reports, note the exact installed version rather than just the tag.

This optional configuration exercises the UI and momentary-switch behaviour without contacting a device:

```json
{
  "platform": "cmdSwitch3",
  "name": "Beta test commands",
  "switches": [
    {
      "name": "cmdSwitch3 beta test button",
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

## Stable release criteria

Aim for at least two weeks of normal use on the final candidate, successful switch/dimmer/sequential tests on more than one installation, and no unresolved pairing, command-failure or state-consistency regressions. Fixes affecting runtime behaviour need a further observation period. Calendar time alone is not a release criterion.
