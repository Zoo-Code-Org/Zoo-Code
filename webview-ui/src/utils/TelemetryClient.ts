import type { Properties } from "posthog-js"

import { type TelemetrySetting, isTelemetryOptedIn } from "@roo-code/types"

type PostHogClient = (typeof import("posthog-js"))["default"]
type CapturedEvent = { eventName: string; properties: Properties }

// posthog-js is large and only useful once telemetry is actually enabled, so it is
// loaded on demand instead of being part of the eager webview bundle.
let posthogModulePromise: Promise<PostHogClient> | undefined
let posthogClient: PostHogClient | undefined
let posthogLoadFailed = false

// Events captured while the PostHog chunk is still in flight. Before this change the
// import was static, so a capture() that ran right after an enabling
// updateTelemetryState() call reached PostHog synchronously; replaying the queue keeps
// that ordering without dropping events that used to be sent.
//
// OVERFLOW POLICY: this queue is a best-effort ordering buffer, not a durable outbox.
//   - Past MAX_PENDING_EVENTS the oldest entries are kept and new events are dropped
//     silently. There is no error and no retry; the cap exists so a pathological
//     startup cannot grow the queue without bound.
//   - After a failed chunk load nothing is queued (posthogLoadFailed), because there is
//     no client to replay to. The flag is cleared when a later opt-in starts a retry, so
//     events captured while that retry is in flight queue again and flush on success.
//   - Disabling telemetry empties the queue, so a re-enable cannot replay events that
//     were captured under a state the user has since turned off.
const MAX_PENDING_EVENTS = 50
const pendingEvents: CapturedEvent[] = []

function loadPostHog(): Promise<PostHogClient> {
	// Clear the failure flag for the retry window: while this attempt is in flight there
	// is no client yet, so capture() must queue instead of dropping events.
	posthogLoadFailed = false

	posthogModulePromise ??= import("posthog-js").then(
		(module) => {
			posthogClient = module.default
			return module.default
		},
		(error: unknown) => {
			// Drop the cached rejection so a later opt-in can retry the chunk load.
			posthogModulePromise = undefined
			posthogLoadFailed = true
			throw error
		},
	)

	return posthogModulePromise
}

class TelemetryClient {
	private static instance: TelemetryClient
	private static telemetryEnabled: boolean = false

	public async updateTelemetryState(
		telemetrySetting: TelemetrySetting,
		apiKey?: string,
		distinctId?: string,
		vscodeTelemetryEnabled: boolean = true,
	): Promise<void> {
		const shouldEnable = Boolean(
			isTelemetryOptedIn(telemetrySetting) && apiKey && distinctId && vscodeTelemetryEnabled,
		)

		TelemetryClient.telemetryEnabled = shouldEnable

		if (!shouldEnable) {
			// Nothing to reset when PostHog was never loaded: reset() before init() only
			// logged a "must initialize PostHog first" error and cleared nothing.
			posthogClient?.reset()
			pendingEvents.length = 0
			return
		}

		let client: PostHogClient

		try {
			client = await loadPostHog()
		} catch (error) {
			console.warn("Failed to load PostHog:", error)
			pendingEvents.length = 0
			return
		}

		// A later updateTelemetryState() call may have disabled telemetry while the
		// chunk was loading; that stale enable must not initialize PostHog.
		if (!TelemetryClient.telemetryEnabled || !apiKey || !distinctId) {
			return
		}

		client.reset()
		client.init(apiKey, {
			api_host: "https://us.i.posthog.com",
			persistence: "localStorage",
			loaded: () => client.identify(distinctId),
			capture_pageview: false,
			capture_pageleave: false,
			autocapture: false,
		})

		this.flushPendingEvents(client)
	}

	public static getInstance(): TelemetryClient {
		if (!TelemetryClient.instance) {
			TelemetryClient.instance = new TelemetryClient()
		}

		return TelemetryClient.instance
	}

	public capture(eventName: string, properties?: Record<string, any>) {
		if (!TelemetryClient.telemetryEnabled) {
			return
		}

		const event: CapturedEvent = {
			eventName,
			properties: {
				appName: process.env.PKG_NAME,
				appVersion: process.env.PKG_VERSION,
				releaseChannel: process.env.PKG_RELEASE_CHANNEL || "stable",
				...properties,
			},
		}

		if (!posthogClient) {
			if (!posthogLoadFailed && pendingEvents.length < MAX_PENDING_EVENTS) {
				pendingEvents.push(event)
			}

			return
		}

		this.send(posthogClient, event)
	}

	private flushPendingEvents(client: PostHogClient) {
		for (const event of pendingEvents.splice(0)) {
			this.send(client, event)
		}
	}

	private send(client: PostHogClient, { eventName, properties }: CapturedEvent) {
		try {
			client.capture(eventName, properties)
		} catch (_error) {
			// Silently fail if there's an error capturing an event.
		}
	}
}

export const telemetryClient = TelemetryClient.getInstance()
