import type { RooCodeAPI } from "@roo-code/types"

declare global {
	// Ambient globals must use var; let/const are not valid here.
	// eslint-disable-next-line no-var -- TypeScript ambient global declaration
	var api: RooCodeAPI
}

export {}
