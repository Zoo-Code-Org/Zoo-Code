export class ReadFileCancelledError extends Error {
	constructor() {
		super("File read cancelled")
		this.name = "ReadFileCancelledError"
	}
}
