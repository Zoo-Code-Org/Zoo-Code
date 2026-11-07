import type { RooCodeAPI, RooCodeTestOnlyApi } from "@roo-code/types"

// The e2e host activates the extension in test mode, where the activation
// object also exposes the production-gated test-only surface (task ask
// control and raw global-state reads) declared in RooCodeTestOnlyApi.
declare global {
	var api: RooCodeAPI & RooCodeTestOnlyApi
}

export {}
