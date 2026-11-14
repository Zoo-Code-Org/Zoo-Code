/**
 * The guarded publish committed the accepted content to disk, but an open buffer
 * with different unsaved edits prevented reconciling the editor. The write is
 * committed: callers must not retry the same (possibly non-idempotent) edit,
 * because re-reading and re-applying it would duplicate the change.
 *
 * Each site adds a `detail` line naming the window it hit - the save that could not
 * clear a dirty buffer, the cancellation that arrived after a commit, the cancellation whose
 * revert left the buffer dirty after the reopen, the move whose source unlink never ran -
 * while the guidance below stays identical everywhere, so one name and one set of
 * instructions covers every committed-write conflict.
 * name and one set of instructions covers every committed-write conflict.
 *
 * Kept in its own vscode-free module so tool-level tests can construct it
 * without loading the DiffViewProvider's editor dependencies.
 */
export class CommittedWriteBufferConflictError extends Error {
	constructor(absolutePath: string, detail?: string) {
		super(
			(detail ? `${detail} ` : "") +
				`The guarded publish committed the accepted content to ${absolutePath}, but an open buffer holds ` +
				"unsaved edits that differ from it; the buffer was kept so those edits are not lost. " +
				"The write is already committed to disk -- do not retry this edit. Save or discard the buffer, " +
				"then read the file again before making a separate edit.",
		)
		this.name = "CommittedWriteBufferConflictError"
	}
}
