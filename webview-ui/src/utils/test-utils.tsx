import React from "react"
import { render as rtlRender, type RenderOptions } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { vi, type Mock } from "vitest"

import type { ExtensionState } from "@roo-code/types"

import { TooltipProvider } from "@src/components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "@src/components/ui/standard-tooltip"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

interface AllTheProvidersProps {
	children: React.ReactNode
}

export const createTestQueryClient = () =>
	new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	})

export const makeExtensionState = (overrides: Partial<ExtensionState> = {}): Partial<ExtensionState> => ({
	version: "1.0.0",
	clineMessages: [],
	taskHistory: [],
	shouldShowAnnouncement: false,
	allowedCommands: [],
	deniedCommands: [],
	allowedReadFiles: [],
	allowedWriteFiles: [],
	alwaysAllowExecute: false,
	cloudIsAuthenticated: false,
	telemetrySetting: "enabled",
	...overrides,
})

export function mockVscodePostMessage(existing?: Mock) {
	const postMessage = existing ?? vi.fn()

	return {
		postMessage,
		cleanup: () => postMessage.mockClear(),
	}
}

const AllTheProviders = ({ children }: AllTheProvidersProps) => {
	const queryClient = createTestQueryClient()

	return (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>{children}</TooltipProvider>
		</QueryClientProvider>
	)
}

const customRender = (ui: React.ReactElement, options?: Omit<RenderOptions, "wrapper">) =>
	rtlRender(ui, { wrapper: AllTheProviders, ...options })

export type RenderWithExtensionStateOptions = {
	state?: Partial<ExtensionState>
	queryClient?: QueryClient
} & Omit<RenderOptions, "wrapper">

export const renderWithExtensionState = (
	ui: React.ReactElement,
	{ state = {}, queryClient = createTestQueryClient(), ...options }: RenderWithExtensionStateOptions = {},
) =>
	rtlRender(ui, {
		wrapper: ({ children }) => (
			<ExtensionStateContextProvider initialState={state}>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>{children}</TooltipProvider>
				</QueryClientProvider>
			</ExtensionStateContextProvider>
		),
		...options,
	})

// re-export everything
export * from "@testing-library/react"

// override render method
export { customRender as render }

type TransportCall = { url: string; method: string; headers: Record<string, string> }
type TransportResult = { status: number; body: unknown; jsonRejects?: Error }

// Stubs global fetch and records the calls.
export const stubTransport = (handler: (call: TransportCall) => TransportResult | Promise<TransportResult>) => {
	const calls: TransportCall[] = []

	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = typeof input === "object" && "url" in input ? input : undefined
		const call: TransportCall = {
			url: request?.url ?? String(input),
			method: init?.method ?? request?.method ?? "GET",
			headers: Object.fromEntries(new Headers(init?.headers ?? request?.headers).entries()),
		}
		calls.push(call)
		const result = await handler(call)

		// The hooks consume only ok, status, and json from this response double.
		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			json: async () => {
				if (result.jsonRejects) {
					throw result.jsonRejects
				}
				return result.body
			},
		} as Response
	})

	return { calls }
}
