import { useCallback, useRef, useState } from "react"

import type { ExtensionMessage, ProviderSettings } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

export interface BedrockMaxTokensProbeResult {
	maxOutputTokens: number
	source: "accepted" | "hint" | "binary-search"
	attempts: number
	modelId: string
}

interface UseBedrockMaxTokensProbeReturn {
	probe: (apiConfiguration: ProviderSettings, modelId: string) => Promise<BedrockMaxTokensProbeResult>
	isProbing: boolean
	lastResult?: BedrockMaxTokensProbeResult
	lastError?: string
	reset: () => void
}

/**
 * Webview-side wrapper around the `requestBedrockMaxTokensProbe` extension message.
 * Mirrors the shape of `useBedrockDiscovery`: returns a function that resolves with
 * the AWS-detected cap (or rejects on error), plus inline state for UI affordances.
 */
export const useBedrockMaxTokensProbe = (): UseBedrockMaxTokensProbeReturn => {
	const [isProbing, setIsProbing] = useState(false)
	const [lastResult, setLastResult] = useState<BedrockMaxTokensProbeResult | undefined>(undefined)
	const [lastError, setLastError] = useState<string | undefined>(undefined)

	// Track in-flight handlers so reset() can safely clear them.
	const pendingHandlerRef = useRef<((event: MessageEvent) => void) | undefined>(undefined)
	const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	const reset = useCallback(() => {
		if (pendingHandlerRef.current && typeof window !== "undefined") {
			window.removeEventListener("message", pendingHandlerRef.current)
		}
		if (pendingTimeoutRef.current) {
			clearTimeout(pendingTimeoutRef.current)
		}
		pendingHandlerRef.current = undefined
		pendingTimeoutRef.current = undefined
		setIsProbing(false)
		setLastResult(undefined)
		setLastError(undefined)
	}, [])

	const probe = useCallback(async (apiConfiguration: ProviderSettings, modelId: string) => {
		setIsProbing(true)
		setLastError(undefined)

		// Clear any prior listener; a new probe always supersedes the previous one.
		if (pendingHandlerRef.current && typeof window !== "undefined") {
			window.removeEventListener("message", pendingHandlerRef.current)
		}
		if (pendingTimeoutRef.current) {
			clearTimeout(pendingTimeoutRef.current)
		}

		const requestId = `bedrock-max-tokens-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

		try {
			const result = await new Promise<BedrockMaxTokensProbeResult>((resolve, reject) => {
				const cleanup = () => {
					if (typeof window !== "undefined" && pendingHandlerRef.current) {
						window.removeEventListener("message", pendingHandlerRef.current)
					}
					pendingHandlerRef.current = undefined
					if (pendingTimeoutRef.current) {
						clearTimeout(pendingTimeoutRef.current)
						pendingTimeoutRef.current = undefined
					}
				}

				// 90s budget covers the worst-case binary search (≈ 17 probes × ~5s each).
				pendingTimeoutRef.current = setTimeout(() => {
					cleanup()
					reject(new Error("Bedrock max output tokens probe timed out"))
				}, 90_000)

				const handler = (event: MessageEvent) => {
					const message = event.data as ExtensionMessage
					if (message.type !== "bedrockMaxTokensProbe" || message.requestId !== requestId) {
						return
					}

					cleanup()

					if (message.error) {
						reject(new Error(message.error))
						return
					}

					if (!message.bedrockMaxTokensProbe) {
						reject(new Error("Bedrock max output tokens probe returned no payload"))
						return
					}

					resolve(message.bedrockMaxTokensProbe)
				}

				pendingHandlerRef.current = handler
				if (typeof window !== "undefined") {
					window.addEventListener("message", handler)
				}

				vscode.postMessage({
					type: "requestBedrockMaxTokensProbe",
					requestId,
					apiConfiguration,
					text: modelId,
				})
			})

			setLastResult(result)
			return result
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			setLastError(message)
			throw error
		} finally {
			setIsProbing(false)
		}
	}, [])

	return { probe, isProbing, lastResult, lastError, reset }
}
