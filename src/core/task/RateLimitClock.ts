export class RateLimitClock {
	private lastRequestTime?: number

	getLastRequestTime(): number | undefined {
		return this.lastRequestTime
	}

	recordRequest(): void {
		this.lastRequestTime = performance.now()
	}
}

export function createRateLimitClock(): RateLimitClock {
	return new RateLimitClock()
}
