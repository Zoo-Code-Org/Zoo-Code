# JSON persistence contract and caller inventory

Update this file when you add a `safeWriteJson` caller.

The canonical file is the committed JSON file.
A backup file contains the previous committed data.
This contract covers the shared JSON writer and its consumers.
It does not guarantee recovery after power loss.

## Find callers

Run this command from the repository root:

```sh
rg -n 'safeWriteJson\(' src --glob '!**/__tests__/**'
```

The results also include the function declaration and text examples.

## Shared contract

- The writer takes the canonical file's advisory lock before recovery, merge, write, or replacement.
- Recovery treats only `ENOENT` as a missing file.
- A failed backup restore stops the write.
- A failed restore or rollback keeps the committed backup.
- The normal commit uses one rename operation.
- The Windows `EPERM` fallback uses two rename operations.
- The writer does not call `fsync`.
- Read recovery searches for a matching backup before it takes the file lock.
- Read recovery checks the canonical file and backups again under that lock.
- Recovery rejects backup symlinks and non-regular files.
- It validates the open backup descriptor before copying bytes into an exclusive temporary file.
- It publishes that regular file by rename and retains the backup until commit.

Recovery uses `O_NOFOLLOW` where Node provides it.
Descriptor and pathname identity checks also apply on platforms without that flag.

A fresh lock can belong to a paused writer.
The protocol does not remove that lock before the stale interval expires.
The stale interval is 31 seconds.
Lock acquisition also has its own retries.
See [fileLock.ts](../../src/utils/fileLock.ts) for the lock configuration.

See [History-file availability](task-lifecycle-model.md#history-file-availability-boundary) for initialization retries and health state.

## Failure reports

A rejected recovery attempt emits `json-recovery-failed` through the shared trace sink.
The event includes the canonical path, process ID, timestamp, and error code.
The event does not include file contents.
UI-message writes also emit task-specific events.
A trace sink failure does not replace the filesystem error.

Leftover-file cleanup errors go to the console.
These errors do not reject a write that otherwise succeeded.

## Consumers

The paths below start at `src/`.
Each consumer uses the shared writer's recovery and lock protocol.
Its read path can have different behavior.

### `api/providers/fetchers/modelEndpointCache.ts`

- Replaces the endpoint cache with fetched data.
- Reads the canonical file directly.
- Fetches data again when the cache is missing.
- Returns write errors to the cache refresh handler.

### `api/providers/fetchers/modelCache.ts`

- Replaces the model cache with fetched data.
- Includes a synchronous reader for the canonical file.
- Fetches data again when the cache is missing.
- Logs refresh write errors.

### `services/mcp/McpHub.ts`

- Creates global settings with a merge that preserves existing settings.
- Preserves settings restored from a backup during creation.
- Reads settings before it takes the write lock for other changes.
- Can lose a concurrent change during these read-modify-write operations.
- This transaction gap is tracked in [#2173](https://github.com/Zoo-Code-Org/Zoo-Code/issues/2173).

### `services/code-index/cache-manager.ts`

- Saves or clears the file-hash cache.
- Reads through the VS Code filesystem API.
- Rebuilds the cache when the file is missing.
- Logs write errors and emits telemetry.

### `core/config/importExport.ts`

- Writes a settings snapshot to the file that the user selects.
- Reads the selected import file directly.
- Logs export errors.

### `core/webview/webviewMessageHandler.ts`

- Creates project MCP settings when the canonical file appears absent.
- Can replace restored settings with defaults during creation.
- This creation gap is tracked in [#2175](https://github.com/Zoo-Code-Org/Zoo-Code/issues/2175).

### `core/task-persistence/taskMessages.ts`

- Saves UI messages, with an optional snapshot merge.
- Uses read retries and backup recovery.
- Emits task-specific write events.
- Returns save errors to the Task save helper, which logs them.

### `core/task-persistence/apiMessages.ts`

- Saves API messages, with an optional snapshot merge.
- Uses backup recovery for current and legacy history reads.
- Returns an empty history only when both history files are missing.
- Throws other read errors.
- Deletes legacy history only after it saves the new file.

### `core/task-persistence/TaskHistoryStore.ts`

- Writes task history, repair intents, merged changes, and conditional action settlement.
- Recovers missing history files during reconciliation and individual reads.
- Forced scans report read errors before delegation repair or replay.
- Background scans retain unreadable cached records and update readable tasks.
- Keeps cached records when a refresh fails.
- Removes backups under the file lock before it deletes canonical history.
- Logs deletion errors other than `ENOENT`.
- Reads repair intents directly from the canonical path.
- The repair-intent recovery gap is tracked in [#2176](https://github.com/Zoo-Code-Org/Zoo-Code/issues/2176).

### `core/context-tracking/FileContextTracker.ts`

- Saves file-context metadata.
- Returns an empty context when the canonical file appears absent.
- Does not recover metadata backups during reads.
- Logs save errors.
- The metadata recovery gap is tracked in [#2177](https://github.com/Zoo-Code-Org/Zoo-Code/issues/2177).

## Other readers and write paths

Legacy history can be displayed while initialization is pending or has failed.
After migration, per-task reads and metadata updates use the file-backed store.
The persisted migration marker keeps this rule active during later startup retries.
A stale legacy row cannot supply a missing task record.

`ClineProvider.getTaskWithId` reads API history through the recovery reader.
It returns an empty history for `SyntaxError` or `ENOENT`.
It throws other read errors.
Task loading and parent reopening also use the message readers.
These read paths do not already hold the same file lock.
Provider delegation locks and store mutexes are separate locks.

Task-history import copies files into a private staging directory.
It validates `history_item.json` before it renames the directory into place.
This directory publication uses a separate protocol.

Repair-intent quarantine and removal use rename or unlink operations.
These operations do not replace JSON content.

`services/marketplace/SimpleInstaller.ts` changes MCP settings with direct file writes.
It does not share the JSON writer's lock.
This writer gap is tracked in [#2174](https://github.com/Zoo-Code-Org/Zoo-Code/issues/2174).

Workspace edits, credential files, and CLI state use other write paths.
This contract does not cover those paths.

## Validation limits

The [writer tests](../../src/utils/__tests__/safeWriteJson.recovery.test.ts) cover restore failures, backup selection, read recovery, and error reports.
The [subprocess tests](../../src/utils/__tests__/safeWriteJson.interruption.test.ts) cover forced termination, fresh locks, and stale-lock recovery.
The [restart E2E test](../../apps/vscode-e2e/src/suite/restart-persistence.test.ts) checks recovery through a fresh extension host.

Injected `EPERM` failures do not prove native Windows behavior.
Native Windows open-handle checks are tracked in [#2178](https://github.com/Zoo-Code-Org/Zoo-Code/issues/2178).
