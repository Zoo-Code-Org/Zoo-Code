/** Request resources exist together; disposed requests retain only their cancellation outcome. */
export type CodexWebSocketRequestStateModel<TSocket, TEvents, TTimer> =
	| { readonly status: "uninitialized" }
	| { readonly status: "initializing"; readonly controller: AbortController; readonly signal: AbortSignal }
	| {
			readonly status: "active"
			readonly controller: AbortController
			readonly signal: AbortSignal
			readonly socket: TSocket
			readonly events: TEvents
			readonly timeout?: TTimer
	  }
	| { readonly status: "disposed"; readonly signal: AbortSignal }
