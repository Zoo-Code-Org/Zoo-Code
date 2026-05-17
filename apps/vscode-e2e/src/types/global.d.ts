import type { RooCodeAPI } from "@roo-code/types"

declare global {
	// eslint-disable-next-line no-var -- var is required in declare global
	var api: RooCodeAPI
}

export {}
