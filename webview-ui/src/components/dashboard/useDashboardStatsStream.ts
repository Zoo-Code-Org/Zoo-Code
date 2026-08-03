// React hook for the dashboard stats stream subscription lifecycle.
// See docs/260729_0001_session_branch-recovery/dashboard-streaming-architecture.md
// for the full specification.

import { useCallback, useEffect, useReducer, useRef, useState } from "react"

import type {
	DashboardStatsSubscription,
	DashboardStatsError,
	DashboardTaskPage,
	DashboardTaskStatsDelta,
	DashboardTaskStatsSnapshot,
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
	/** Maximum tasks per page (1–100). Default 50. */
	sessionPageSize?: number
	/** Whether the webview is currently visible. Default true. */
	visible?: boolean
}

export interface UseDashboardStatsStreamResult {
	state: DashboardStreamState
	/** Request an additional task page using the current cursor. */
	requestTaskPage: (cursor?: string) => void
	/** Whether an additional task page request is in flight. */
	isTaskPageLoading: boolean
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
	const [isTaskPageLoading, setIsTaskPageLoading] = useState(false)

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
			setIsTaskPageLoading(false)
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
					const snapshot: DashboardTaskStatsSnapshot | undefined = message.dashboardStatsStreamSnapshot
					if (snapshot) {
						// Stale-epoch check using ref (synchronous) to avoid race condition
						// where snapshot arrives before React processes REPLACE_SUBSCRIPTION dispatch.
						// The reducer also has this check but uses state.subscriptionId which is async.
						if (snapshot.requestId === subscriptionIdRef.current) {
							dispatch({ type: "SNAPSHOT", snapshot })
							setIsTaskPageLoading(false)
						}
					}
					break
				}
				case "dashboardStatsStreamDelta": {
					const delta: DashboardTaskStatsDelta | undefined = message.dashboardStatsStreamDelta
					if (delta) {
						// Same stale-epoch check for deltas
						if (delta.requestId === subscriptionIdRef.current) {
							dispatch({ type: "DELTA", delta })
						}
					}
					break
				}
				case "dashboardStatsStreamError": {
					const error: DashboardStatsError | undefined = message.dashboardStatsStreamError
					if (error) {
						// Only process errors for the current subscription epoch
						if (error.requestId === subscriptionIdRef.current) {
							dispatch({ type: "ERROR", error })
						}
					}
					break
				}
				case "dashboardTaskPageResponse": {
					const page: DashboardTaskPage | undefined = message.dashboardTaskPage
					if (page) {
						// Only process task pages for the current subscription epoch.
						if (page.requestId === subscriptionIdRef.current) {
							dispatch({ type: "TASK_PAGE", page })
							setIsTaskPageLoading(false)
						}
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

	// ── Loading timeout guard ──────────────────────────────────────────────
	useEffect(() => {
		if (state.isLoading) {
			const timer = setTimeout(() => {
				dispatch({
					type: "ERROR",
					error: {
						requestId: subscriptionIdRef.current ?? "",
						code: "STATS_HANDLER/stream/timeout",
						message: "Dashboard request timed out",
					},
				})
			}, 10000)
			return () => clearTimeout(timer)
		}
	}, [state.isLoading, state.subscriptionId])

	// ── requestTaskPage ─────────────────────────────────────────────────────
	const requestTaskPage = useCallback(
		(cursor?: string) => {
			if (!subscriptionIdRef.current || isTaskPageLoading) return
			const effectiveCursor = cursor ?? state.taskCursor
			if (!effectiveCursor) return
			setIsTaskPageLoading(true)
			vscode.postMessage({
				type: "getDashboardTaskPage",
				requestId: subscriptionIdRef.current,
				dashboardTaskCursor: effectiveCursor,
				dashboardTaskLimit: sessionPageSizeRef.current,
			})
		},
		[state.taskCursor, isTaskPageLoading],
	)

	// ── replaceSubscription ──────────────────────────────────────────────────
	const replaceSubscription = useCallback(
		(newRange: StatsQuery, newHeatmapRangeDays: number, newSessionPageSize?: number) => {
			const requestId = generateRequestId("replace")
			subscriptionIdRef.current = requestId
			setIsTaskPageLoading(false)

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
		requestTaskPage,
		isTaskPageLoading,
		replaceSubscription,
	}
}
