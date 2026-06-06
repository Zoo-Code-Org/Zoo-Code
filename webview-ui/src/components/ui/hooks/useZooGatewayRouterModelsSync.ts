import { useCallback, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"

import type { ExtensionMessage, RouterModels } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import { fetchRouterModels } from "./useRouterModels"

/**
 * Keeps zoo-gateway models in the shared routerModels query fresh when credentials
 * become available (sign-in or profile seeding) without coupling auth to modelCache.
 */
export function useZooGatewayRouterModelsSync() {
	const queryClient = useQueryClient()
	const { zooCodeIsAuthenticated } = useExtensionState()
	const wasAuthenticatedRef = useRef<boolean | undefined>(undefined)

	const syncZooGatewayModels = useCallback(async () => {
		if (!zooCodeIsAuthenticated) {
			return
		}

		try {
			const partial = await fetchRouterModels("zoo-gateway")
			const zooModels = partial["zoo-gateway"]
			if (!zooModels || Object.keys(zooModels).length === 0) {
				return
			}

			queryClient.setQueryData<RouterModels>(["routerModels", "all"], (current) =>
				current ? { ...current, "zoo-gateway": zooModels } : partial,
			)
		} catch {
			// Ignore: bulk router fetch may still be in flight.
		}
	}, [queryClient, zooCodeIsAuthenticated])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const message = event.data as ExtensionMessage
			if (message.type === "zooGatewayCredentialsReady") {
				void syncZooGatewayModels()
			}
		}

		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [syncZooGatewayModels])

	useEffect(() => {
		const wasAuthenticated = wasAuthenticatedRef.current
		wasAuthenticatedRef.current = zooCodeIsAuthenticated

		if (zooCodeIsAuthenticated && wasAuthenticated === false) {
			void syncZooGatewayModels()
		}
	}, [zooCodeIsAuthenticated, syncZooGatewayModels])
}
