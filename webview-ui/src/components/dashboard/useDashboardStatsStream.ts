// React hook for the dashboard stats stream subscription lifecycle.
// See docs/260729_0001_session_branch-recovery/dashboard-streaming-architecture.md
// for the full specification.

import { useCallback, useEffect, useReducer, useRef } from "react"

import type {
	DashboardStatsSubscription,
	DashboardStatsSnapshot,
	DashboardStatsDelta,
	DashboardStatsError,
	DashboardSessionPage,
	StatsQuery,
} from "@roo-code/types"

import { vscode } from "@/utils/vscode"

import {
	dashboardStreamReducer,
	initialDashboardStreamState,
	type DashboardStreamState,
} from "./dashboardStreamReducer"

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseDashboardStatsStreamOptions {
	/** Main dashboard time range query. */
	range: StatsQuery
	/** Number of days for the heatmap (30, 60, 120, 360). */
	heatmapRangeDays: number
	/** Maximum sessions per page (1–100). Default 50. */
	sessionPageSize?: number
	/** Whether the webview is currently visible. Default true. */
	visible?: boolean
}

export interface UseDashboardStatsStreamResult {
	state: DashboardStreamState
	/** Request an additional session page using the current cursor. */
	requestSessionPage: (cursor?: string) => void
	/** Replace the subscription with a new query set (new epoch). */
	replaceSubscription: (range: StatsQuery, heatmapRangeDays: number, sessionPageSize?: number) => void
}

// ── Hook ─────────────────────────────────────────────────────────────────────

let subscriptionCounter = 0

function generateRequestId(prefix: string): string {
	subscriptionCounter += 1
	return `dashboard-stream-${prefix}-${Date.now()}-${subscriptionCounter}`
}

export function useDashboardStatsStream(options: UseDashboardStatsStreamOptions): UseDashboardStatsStreamResult {
	const { range, heatmapRangeDays, sessionPageSize = 50, visible = true } = options

	const [state, dispatch] = useReducer(dashboardStreamReducer, initialDashboardStreamState)

	// Refs to avoid stale closures in event listeners and effects
	const visibleRef = useRef(visible)
	visibleRef.current = visible

	const subscriptionIdRef = useRef<string | null>(null)
	const rangeRef = useRef(range)
	rangeRef.current = range
	const heatmapRangeDaysRef = useRef(heatmapRangeDays)
	heatmapRangeDaysRef.current = heatmapRangeDays
	const sessionPageSizeRef = useRef(sessionPageSize)
	sessionPageSizeRef.current = sessionPageSize

	// Track whether we've already sent the initial subscribe
	const subscribedRef = useRef(false)

	// ── Subscribe on mount ──────────────────────────────────────────────────
	useEffect(() => {
		const requestId = generateRequestId("sub")
		subscriptionIdRef.current = requestId

		const subscription: DashboardStatsSubscription = {
			requestId,
			range: rangeRef.current,
			sessionPageSize: sessionPageSizeRef.current,
			heatmapRangeDays: heatmapRangeDaysRef.current,
		}

		dispatch({ type: "SUBSCRIBE", subscription })
		vscode.postMessage({ type: "subscribeDashboardStats", dashboardStatsSubscription: subscription })
		subscribedRef.current = true

		return () => {
			if (subscriptionIdRef.current) {
				vscode.postMessage({
					type: "unsubscribeDashboardStats",
					requestId: subscriptionIdRef.current,
				})
			}
			subscriptionIdRef.current = null
			subscribedRef.current = false
		}
	}, [])

	// ── Message listener ─────────────────────────────────────────────────────
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data

			if (!message || typeof message.type !== "string") {
				return
			}

			switch (message.type) {
				case "dashboardStatsStreamSnapshot": {
					const snapshot: DashboardStatsSnapshot | undefined = message.dashboardStatsStreamSnapshot
					if (snapshot) {
						dispatch({ type: "SNAPSHOT", snapshot })
					}
					break
				}
				case "dashboardStatsStreamDelta": {
					const delta: DashboardStatsDelta | undefined = message.dashboardStatsStreamDelta
					if (delta) {
						dispatch({ type: "DELTA", delta })
					}
					break
				}
				case "dashboardStatsStreamError": {
					const error: DashboardStatsError | undefined = message.dashboardStatsStreamError
					if (error) {
						dispatch({ type: "ERROR", error })
					}
					break
				}
				case "dashboardSessionPageResponse": {
					const page: DashboardSessionPage | undefined = message.dashboardSessionPage
					if (page) {
						dispatch({ type: "SESSION_PAGE", page })
					}
					break
				}
				case "action": {
					// Handle visibility changes from the extension host
					if (message.action === "didBecomeVisible") {
						// The host sends didBecomeVisible when the webview becomes visible.
						// If we have a subscription and were paused, resume.
						if (subscriptionIdRef.current && !visibleRef.current) {
							visibleRef.current = true
							vscode.postMessage({
								type: "resumeDashboardStats",
								requestId: subscriptionIdRef.current,
							})
						}
					}
					break
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	// ── Pause on hidden, resume on visible ───────────────────────────────────
	useEffect(() => {
		if (!subscribedRef.current) return

		if (!visible && subscriptionIdRef.current) {
			vscode.postMessage({
				type: "pauseDashboardStats",
				requestId: subscriptionIdRef.current,
			})
		} else if (visible && subscriptionIdRef.current) {
			vscode.postMessage({
				type: "resumeDashboardStats",
				requestId: subscriptionIdRef.current,
			})
		}
	}, [visible])

	// ── requestSessionPage ──────────────────────────────────────────────────
	const requestSessionPage = useCallback(
		(cursor?: string) => {
			if (!subscriptionIdRef.current) return
			const effectiveCursor = cursor ?? state.sessionCursor
			vscode.postMessage({
				type: "getDashboardSessionPage",
				requestId: subscriptionIdRef.current,
				dashboardSessionCursor: effectiveCursor,
				dashboardSessionLimit: sessionPageSizeRef.current,
			})
		},
		[state.sessionCursor],
	)

	// ── replaceSubscription ──────────────────────────────────────────────────
	const replaceSubscription = useCallback(
		(newRange: StatsQuery, newHeatmapRangeDays: number, newSessionPageSize?: number) => {
			const requestId = generateRequestId("replace")
			subscriptionIdRef.current = requestId

			const effectivePageSize = newSessionPageSize ?? sessionPageSizeRef.current

			const subscription: DashboardStatsSubscription = {
				requestId,
				range: newRange,
				sessionPageSize: effectivePageSize,
				heatmapRangeDays: newHeatmapRangeDays,
			}

			dispatch({ type: "REPLACE_SUBSCRIPTION", subscription })
			vscode.postMessage({
				type: "replaceDashboardStatsSubscription",
				dashboardStatsSubscription: subscription,
			})
		},
		[],
	)

	return {
		state,
		requestSessionPage,
		replaceSubscription,
	}
}
