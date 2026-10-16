/**
 * Releases host resources an API handler owns, such as the configuration listener VS Code LM and
 * GitHub Copilot handlers register. Handlers without a `dispose()` method hold nothing to release.
 *
 * This lives apart from `api/index.ts` so callers keep cleaning up even where tests replace that
 * module with a partial fake. It is typed structurally so it does not depend on that module either.
 */
export function disposeApiHandler(handler: object | null | undefined): void {
	if (handler && "dispose" in handler && typeof handler.dispose === "function") {
		handler.dispose()
	}
}
