# Zoo CLI Release Review

This checklist records the release gates for the initial `zoo` CLI. It is evidence for maintainers, not a claim that unsupported capabilities exist.

## Security

- [x] Dedicated IPC carries protocol data; child stdout cannot contaminate machine output.
- [x] Safe automation returns `needs_input`; auto approval preserves explicit denials and hard boundaries.
- [x] Run overrides remain in memory and propagate through delegation without profile/settings mutation.
- [x] macOS Keychain and Linux Secret Service adapters avoid plaintext files and secret argv values.
- [x] Stateful bounded redaction covers events, command output, diagnostics, errors, and folded headers.
- [x] Workspace/session identity is canonicalized and pinned per host.
- [x] Startup, heartbeat, commands, timeout, cancellation, flush, shutdown, and kill phases are bounded.

## Privacy And Telemetry

- [x] The production extension retains its canonical telemetry preference and flush behavior.
- [x] Public events exclude prompts/tool payloads beyond redacted terminal-visible activity.
- [x] Debug diagnostics are opt-in, bounded, redacted, and sent only to stderr.
- [x] Machine stdout contracts contain no hidden analytics or log records.
- [ ] Dedicated `client=cli` telemetry tagging is required before enabling CLI-specific product analytics. Until then, no CLI-only prompt, tool, or command telemetry is introduced.

## Artifacts

- [x] Matrix is limited to macOS ARM64 and Linux x64/ARM64.
- [x] Artifacts lock client, host, protocol, extension bundle, and Node 22 runtime expectations.
- [x] Each artifact runs live `--help` and `--version` smoke checks.
- [x] SHA-256 checksum accompanies every tarball.
- [x] Unit, host, packaged-process, type, and lint gates run before assembly.
- [ ] Signing and npm publication credentials remain maintainer-controlled release steps.

## Rollback And Support

Artifacts and tags are immutable release units. Rollback selects an earlier artifact; it never deletes or migrates `~/.zoo`, VS Code, or inherited `roo` data. Support requests should include `zoo --version`, platform, exit code, and redacted `--debug` stderr. Do not request prompt contents, API keys, vault exports, or unredacted event streams.
