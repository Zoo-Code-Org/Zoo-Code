/** Reports every failure encountered while disposing code index managers. */
export class CodeIndexDisposalError extends AggregateError {
	declare errors: unknown[]

	constructor(errors: readonly unknown[]) {
		const details = errors.map(
			(error, index) => `${index + 1}. ${error instanceof Error ? error.message : String(error)}`,
		)
		super(errors, `Failed to dispose code index managers (${errors.length} errors):\n${details.join("\n")}`)
		this.name = "CodeIndexDisposalError"
	}
}
