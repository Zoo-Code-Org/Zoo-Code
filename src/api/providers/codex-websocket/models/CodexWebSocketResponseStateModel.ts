import type { PreparedCodexRequest } from "./PreparedCodexRequest"

/** Cache-miss recovery is possible only while awaiting the first response event. */
export type CodexWebSocketResponseStateModel =
	| { readonly status: "uninitialized" }
	| { readonly status: "awaiting"; readonly prepared: PreparedCodexRequest }
	| { readonly status: "recovering"; readonly prepared: PreparedCodexRequest }
	| { readonly status: "streaming"; readonly prepared: PreparedCodexRequest; readonly output: readonly unknown[] }
	| { readonly status: "completed"; readonly prepared: PreparedCodexRequest }
