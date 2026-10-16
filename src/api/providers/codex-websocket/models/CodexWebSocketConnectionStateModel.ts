/** Valid runtime states. Resource types are injected so the model does not depend on scopes or IO. */
export type CodexWebSocketConnectionStateModel<TScope, TTimer> =
	| { readonly status: "disconnected" }
	| { readonly status: "connecting"; readonly key: string; readonly scope: TScope }
	| {
			readonly status: "active"
			readonly key: string
			readonly scope: TScope
			readonly connectedAt: number
	  }
	| {
			readonly status: "idle"
			readonly key: string
			readonly scope: TScope
			readonly connectedAt: number
			readonly idleTimer: TTimer
	  }
	| { readonly status: "unavailable"; readonly key: string; readonly retryAt: number }
