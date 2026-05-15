# Attributions

This project is derived from and/or integrates work from the upstream projects listed below. Preserve upstream license headers and copyright notices in copied or modified files.

| Project   | Repository                               | License            | Notes                                                                             |
| --------- | ---------------------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| Zoo Code  | https://github.com/Zoo-Code-Org/Zoo-Code | Apache License 2.0 | Current source base for this repository.                                          |
| Roo Code  | https://github.com/RooCodeInc/Roo-Code   | Apache License 2.0 | Upstream heritage for the VS Code extension and related packages.                 |
| Kilo Code | https://github.com/Kilo-Org/kilocode     | MIT License        | Reference/source for the planned OpenCode-derived CLI core and SDK patterns.      |
| OpenCode  | https://github.com/anomalyco/opencode    | MIT License        | Upstream CLI core reference and optional cleaner base for future CLI import work. |

## Imported Source Inventory

- `packages/zoo-cli` imports Kilo Code's `packages/opencode` from `Kilo-Org/kilocode` commit `a4218d893d4b7ecf6921531c553d84905b8510c0` and keeps a package-local MIT `LICENSE` copied from that source revision.

## License Notes

- The repository root `LICENSE` contains the Apache License 2.0 text for Zoo Code.
- Roo Code attribution and Apache 2.0 notices must be preserved in copied or derived VS Code extension files.
- Kilo Code and OpenCode MIT notices must be preserved if code from those repositories is imported.
- No upstream license headers were removed as part of this attribution inventory.
