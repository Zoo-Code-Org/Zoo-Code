// Returns true when a string is shaped like a filesystem path (Windows
// drive-letter, POSIX absolute, POSIX home, POSIX relative). Pure and
// dependency-free so it can be shared between the extension runtime (e.g.
// parseVertexJsonCredentials) and the webview UI (e.g. the Vertex settings
// warning), guaranteeing both surfaces agree on what "looks like a path"
// means.
//
// Returns false for nullish, empty, and whitespace-only input — neither
// call site should warn in those cases.
export function looksLikeFilePath(value: string | null | undefined): boolean {
	if (value == null) {
		return false
	}
	const trimmed = value.trim()
	if (!trimmed) {
		return false
	}
	return (
		/^[A-Za-z]:[\\/]/.test(trimmed) || // Windows: C:\... or C:/...
		trimmed.startsWith("/") || // POSIX absolute: /home/...
		trimmed.startsWith("~") || // POSIX home: ~/...
		trimmed.startsWith(".") // POSIX relative: ./... or ../...
	)
}
