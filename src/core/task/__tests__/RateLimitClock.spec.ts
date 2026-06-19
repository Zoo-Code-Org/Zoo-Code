import { RateLimitClock, createRateLimitClock } from "../RateLimitClock"

describe("RateLimitClock", () => {
	it("returns undefined when no request has been recorded", () => {
		const clock = createRateLimitClock()
		expect(clock.getLastRequestTime()).toBeUndefined()
	})

	it("records a request and returns a timestamp", () => {
		const clock = createRateLimitClock()
		clock.recordRequest()
		const time = clock.getLastRequestTime()
		expect(time).toBeDefined()
		expect(time).toBeGreaterThan(0)
	})

	it("updates timestamp on subsequent calls", () => {
		const clock = createRateLimitClock()
		clock.recordRequest()
		const first = clock.getLastRequestTime()!
		clock.recordRequest()
		const second = clock.getLastRequestTime()!
		expect(second).toBeGreaterThanOrEqual(first)
	})

	it("isolates state between different clocks", () => {
		const clock1 = createRateLimitClock()
		const clock2 = createRateLimitClock()

		clock1.recordRequest()

		expect(clock1.getLastRequestTime()).toBeDefined()
		expect(clock2.getLastRequestTime()).toBeUndefined()
	})
})
