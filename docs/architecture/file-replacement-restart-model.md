# File replacement and restart model

`scripts/check-file-replacement-restart.ts` is an independent bounded submodel
under `pnpm lifecycle:model-check`. It preserves the completion-readiness model's
separate scope. It checks three files, one initial publication per file, one later
replacement of any one file, and one process crash at every publication or
replacement boundary. Exploration runs to a fixed point with a 10,000-state cap.

## Contract and production mapping

| Model action                                   | Production boundary                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish-ui`, `publish-api`, `publish-history` | Successful writes of `ui_messages.json`, `api_conversation_history.json`, and `history_item.json`                                                                                                                                                                                                                                  |
| `acknowledge-all-three-files`                  | Explicit readiness conjunction in the restart E2E: `hasTaskUiMessageText`, `hasTaskApiConversationHistorySequence`, and `getTaskHistoryItem`. For a newly created task, `TaskHistoryStore.upsertCore` publishes its cache entry after `writeTaskFile` succeeds. This is a test readiness boundary, not a new public runtime event. |
| `stage-replacement-*`                          | `safeWriteJson` writes and flushes a `.new_*.tmp` file under the advisory lock                                                                                                                                                                                                                                                     |
| `atomic-commit`                                | Single temp-to-canonical rename                                                                                                                                                                                                                                                                                                    |
| `eperm-backup-rename`, `fallback-commit`       | Windows-compatible EPERM fallback: canonical-to-backup, then temp-to-canonical                                                                                                                                                                                                                                                     |
| `process-crash`                                | Process exits without rollback, cleanup, or lock release                                                                                                                                                                                                                                                                           |
| `lock-becomes-stale`                           | `proper-lockfile` staleness check using the shared 31-second window                                                                                                                                                                                                                                                                |
| `fresh-host-startup`, `locked-reader-recovery` | `TaskHistoryStore.reconcile` recovers a missing history record before stat/read; `readFileWithMissingRetry` invokes the same recovery after a second ENOENT for UI/API reads                                                                                                                                                       |
| `recovery-io-failure`                          | Recovery scan, access, stat, or restore fails; rejection preserves committed backups for a later retry                                                                                                                                                                                                                             |
| `explicit-delete-under-lock`                   | `deleteJsonFile` removes matching replacements/backups before the canonical file, serialized with writers and recovery; store deletion remains best effort                                                                                                                                                                         |

The UI marker can become visible while history publication is still pending.
`Task.saveClineMessages` persists UI messages before updating metadata, and logs
metadata failures independently. Neither `TaskCompleted` nor UI-marker visibility
promises that all three files exist. The model explicitly reaches that partial
publication state and permits interruption there. It requires restart discovery
only after the readiness conjunction, not after an unfinished first write.

After acknowledgment, the latest committed version of each required file must
remain in either the canonical file or its backup until explicit deletion.
Completed fresh reads must return those committed versions and find the history
record without a new write. A failed recovery must preserve every file version.
Successful explicit deletion must leave no recoverable version to resurrect.
The model requires reachable atomic and fallback successes, restart recovery,
recovery after failure, partial publication, and reads after deletion.

The checker first runs the old two-rename protocol without reader recovery and
requires a #2130 counterexample. It then exhaustively checks the fixed protocol.
This is an abstract protocol check, not execution of the production writer.

## Refinement evidence

`src/utils/__tests__/safeWriteJson.interruption.test.ts` runs the real bundled
writer in a child process, terminates it with SIGKILL, and exercises both commit
paths before and after the replacement rename for all three filenames. Initial
publication uses the production writer. UI/API tests call production readers;
history-record cases initialize a fresh `TaskHistoryStore` before any recovery
write. One case leaves the crash lock's timestamp unchanged, proving the fresh
store can wait for staleness instead of requiring the test to age the lock.

`safeWriteJson.test.ts` injects directory scan, access, backup stat, and restore
failures, checking backup preservation and retry. The store deletion tests cover
single and batch deletion, leftover cleanup, unrelated-file preservation, and
cleanup failure retaining the canonical copy. The existing two-extension-host
restart E2E remains the production activation/rehydration boundary check.

## Assumptions and limits

This is process-crash safety on filesystems with atomic same-directory rename,
not power-loss safety. Parent directories are not fsynced. Locks are advisory;
all writers, recoverers, and history-file deleters must use the shared protocol.
Live holders refresh their locks and must not be mistaken for crashed holders;
filesystem clock behavior and lock compromise are outside the model. Recovery
waits up to 35 lock retries at one-second intervals, then reports a lock failure.
An indefinitely active writer or persistent filesystem fault can still prevent
recovery; no liveness guarantee is claimed under such faults.

Recovery is abstracted as a locked restore and cleanup; repeated crashes during
recovery, multiple orphaned versions, external file removal, arbitrary overlapping
writers, and deletion interrupted between individual unlinks are not exhaustively
modeled. Focused tests cover newest-backup selection and filesystem failures.
Deletion does not prohibit an explicit later creation of a task at the same path
or a stale writer that deliberately publishes new data after deletion. The
no-resurrection property concerns recovery from leftovers after successful
deletion. Lifecycle status/delegation reducers and completion-event semantics
are unchanged.
