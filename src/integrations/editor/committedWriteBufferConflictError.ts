/**
 * The guarded publish committed the accepted content to disk, but an open buffer
 * with different unsaved edits prevented reconciling the editor. The write is
 * committed: callers must not retry the same (possibly non-idempotent) edit,
 * because re-reading and re-applying it would duplicate the change.
 *
 * Kept in its own vscode-free module so tool-level tests can construct it
 * without loading the DiffViewProvider's editor dependencies.
 */
export class CommittedWriteBufferConflictError extends Error {
	constructor(absolutePath: string) {
		super(
			`saveDirectly: the guarded publish committed the accepted content to ${absolutePath}, but the file is ` +
				"open with unsaved edits that differ from it; the buffer was kept so those edits are not lost. " +
				"The write is already committed to disk -- do not retry this edit. Save or discard the buffer, " +
				"then read the file again before making a separate edit.",
		)
		this.name = "CommittedWriteBufferConflictError"
	}
}
