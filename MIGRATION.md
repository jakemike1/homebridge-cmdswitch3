# Migrating from cmdSwitch2

This beta is **not an automatic in-place update** of cmdSwitch2. It registers as `homebridge-cmdswitch3` / `cmdSwitch3` and requires Homebridge 2. Installing it beside cmdSwitch2 will not transfer the old plugin's accessories or pairing automatically.

I completed one controlled migration of six existing switches on Homebridge 2.4.0 / Node 24.19.0, retaining their bridge identity, pairing data, accessory identifiers and services. That installation remains on the private beta.1 build. Public beta.2 uses the same runtime; publishing it does not update that installation.

## What stays compatible

Exact accessory names produce the same UUIDs as the original. Switches remain Switch services; dimmers remain Lightbulb services. Manufacturer/model/serial values, shell command syntax, dimming environment variable, polling, sequential mode and one-action switches are supported. Status/start-only switches can retain `/bin/true` as OFF; this project does not add a stop command.

Synthetic tests construct six original switches and a dimmer using the archived original source with inert adapters for removed APIs. After an explicit test-only cache ownership transfer, they preserve UUIDs, AIDs, service and characteristic IDs, categories and links through two cache restorations. This proves structural compatibility under the stated conditions. The controlled live migration additionally verified unchanged pairing records and identifier caches, with 42 readable characteristics passing. Controller-side automation execution and physical device actions were not triggered during that verification; they must be checked separately.

## Changes to account for

- Homebridge 1 and the old configuration wizard are unsupported. Use Homebridge UI's new Settings page.
- No logs is an explicit preference, default false; choose `noLogs: true` to retain the quiet behaviour of the old no-logs fork.
- Commands have real deadlines and can fail while waiting in a queue. A busy sequential platform may need shorter checks or a longer poll interval. No command is acknowledged as successful merely because a timer elapsed.
- `timeout` remains a post-action refresh delay. Use `commandTimeout` / `stateTimeout` for execution deadlines.
- Dimmer state output must be a plain integer 0–100. Old scripts that embed a number in explanatory text need adjusting.
- Dimmer ON restores a positive remembered level. Failed commands no longer leave optimistic brightness behind. The service environment is preserved when setting `HB_BRIGHTNESS`.
- Duplicate names, invalid numbers and malformed cached service types produce errors rather than silent recreation.
- Poll intervals begin after a completed check; polling cannot build an unbounded backlog.
- New cached context does not store command strings. Existing configuration remains the source of commands.

## Plan an existing-installation migration

There is **no automatic migration command** in this beta. Installing the package and changing `platform` alone is insufficient. If you want to help test without touching existing accessories, use a separate Homebridge instance with distinct example names.

For an existing installation, an experienced administrator should:

1. Make a fresh, private recovery backup of configuration, installed plugin versions, cached accessories, pairing data and identifier caches. Keep recovery material on trusted storage; never attach it to an issue.
2. Record the existing child bridge identity and exact accessory names, types, UUIDs, AIDs, service/characteristic IDs and links. Inventory custom scripts and commands, including deliberate no-op actions.
3. Compare the live state before editing. Preserve the same bridge username, port, pairing data and identifier cache. Retarget only the intended cached accessory plugin/platform ownership to `homebridge-cmdswitch3` / `cmdSwitch3`, preserving every other cached field. Preserve unknown configuration fields and unrelated platforms.
4. Arrange a controlled stop/edit/start so a running old child cannot overwrite the cache change. **Plan for a full Homebridge restart:** Homebridge 2.4.0 needed its parent process restarted to discover the newly installed plugin and platform mapping. A child-only restart was insufficient in the tested migration. This temporarily interrupts other child bridges.
5. Verify that the original accessories restore without removal or recreation; compare all recorded identities, services and pairings. Check state reads, settings assets and logs, then test your scenes and automations deliberately when their actions are appropriate.
6. If validation fails, stop and restore only the affected plugin/configuration/cache ownership from the fresh baseline. Preserve unrelated newer changes. Do not overwrite an entire historical cache or pairing tree as a shortcut.

Do not remove or re-pair existing accessories to work around a migration problem: that can break Home references and automations. Pairing preservation depends on the complete bridge/cache migration, not merely matching UUIDs. A device-specific migration tool is deliberately not included because it would need to validate each installation's live state first.

## Updating an existing cmdSwitch3 beta

Once the plugin/platform ownership is already `homebridge-cmdswitch3` / `cmdSwitch3`, ordinary package updates do not need the cmdSwitch2 ownership transfer. Back up, read the release notes, update to an explicit beta version, restart the affected bridge as required by your Homebridge installation, and verify your accessories. Keep the previous package version available for rollback. Beta.1 was a private build and cannot be restored from the public npm registry.
