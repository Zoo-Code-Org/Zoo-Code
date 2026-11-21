/** Return a filesystem error code without assuming the thrown value is an Error. */
export function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined
}
