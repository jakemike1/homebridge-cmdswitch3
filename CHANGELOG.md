# Changelog

## 1.0.0-beta.3 — startup and cleanup hardening

- Contain invalid configuration, malformed cached accessories and unexpected startup/state-publication errors. Log a sanitized diagnostic, stop the affected platform and retain cached accessories instead of throwing through Homebridge lifecycle events.
- Keep platforms without a switch list inactive. Preserve explicit empty-list removal for deliberate configuration changes, and prevent repeated startup events from duplicating work.
- Close the scheduler before releasing command reservations during shutdown or disablement, so cleanup cannot launch queued actions.
- Handle stdout/stderr stream errors as bounded command failures, without logging their contents.
- Add lifecycle/stream regression tests and an offline packed-install smoke check to Linux/macOS Node 22/24/26 CI. Keep existing identity, dimming, sequencing, quiet-logging and settings tests.
- Document error recovery and the custom editor's first-platform limitation. Use portable shell commands in the beta test examples.

This remains a public beta, not a Homebridge verification approval. Existing installations change only when their owner updates them; this release does not automatically migrate cmdSwitch2 accessories.

## 1.0.0-beta.2 — first public beta

- Publish as `homebridge-cmdswitch3` under npm's `beta` tag, for Homebridge 2 on Linux and macOS.
- Add installation instructions, beta testing guidance, migration limitations, issue templates and automated CI.
- Add repository/support metadata and keep Apache-2.0 licence and original attribution.
- Runtime and packaged settings assets are unchanged from the tested private beta.1. Existing private installations are not updated by this release.

The beta includes switches, dimmers, momentary actions, sequential command execution, a responsive settings page and opt-in quiet logging. It also includes execution deadlines, bounded queues, honest command errors, stale-state protection and lifecycle cleanup.

This is not an automatic in-place update from cmdSwitch2. Read [MIGRATION.md](MIGRATION.md) before considering migration. Physical dimming and controller-side automation execution still need broader testing.

## 1.0.0-beta.1 — private build

Initial Homebridge 2 successor based on luisiam/homebridge-cmdswitch2, with maintained scheduling and state handling, restored dimming and a new settings UI. Tested locally and migrated to one existing Raspberry Pi installation with its six switch identities and pairing data preserved. Not published to npm.
