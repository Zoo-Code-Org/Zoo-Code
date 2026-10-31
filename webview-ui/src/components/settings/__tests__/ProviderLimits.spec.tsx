import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type ProviderQuota } from "@roo-code/types"

import { ProviderLimits } from "../ProviderLimits"

const post = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: post } }))

// Render the key plus its interpolation values so assertions can see the formatted output.
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, string>) =>
			options ? `${key} ${Object.values(options).join(" ")}` : key,
	}),
}))

/** The id the component put on its most recent request (the host echoes it back). */
const lastRequestId = () => {
	const requests = post.mock.calls.map((c) => c[0]).filter((m) => m.type === "requestProviderQuotas")
	return requests.at(-1)?.requestId as string
}

/** Answers the most recent request, or the given id. Pass `null` to send an answer with no id at all. */
const lastRequestIdAfterRender = (Component: typeof ProviderLimits = ProviderLimits) => {
	post.mockClear()
	const view = render(<Component />)
	const id = lastRequestId()
	view.unmount()
	return id
}

const respond = (providerQuotas: ProviderQuota[], id?: string | null) =>
	act(() => {
		const requestId = id === null ? undefined : (id ?? lastRequestId())
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "providerQuotas", providerQuotas, requestId } }),
		)
	})

describe("ProviderLimits", () => {
	beforeEach(() => {
		post.mockClear()
	})

	it("asks the extension for quotas on mount without forcing", () => {
		render(<ProviderLimits />)
		expect(post).toHaveBeenCalledWith({
			type: "requestProviderQuotas",
			bool: false,
			requestId: expect.stringMatching(/^provider-quotas-[a-z0-9]+-\d+$/),
		})
	})

	describe("when the webview regains focus", () => {
		const requests = () => post.mock.calls.map((c) => c[0]).filter((m) => m.type === "requestProviderQuotas")

		it("asks again without forcing, so a profile saved elsewhere is picked up", () => {
			render(<ProviderLimits />)
			expect(requests()).toHaveLength(1)

			act(() => {
				window.dispatchEvent(new Event("focus"))
			})

			expect(requests()).toHaveLength(2)
			expect(requests()[1]).toMatchObject({ bool: false })
			expect(requests()[1].requestId).not.toBe(requests()[0].requestId)
		})

		it("stops listening once the section is gone", () => {
			const { unmount } = render(<ProviderLimits />)
			unmount()
			post.mockClear()

			act(() => {
				window.dispatchEvent(new Event("focus"))
			})

			expect(requests()).toHaveLength(0)
		})
	})

	describe("progress bars", () => {
		it("names each bar with its provider and window, so two windows of one provider can be told apart", () => {
			render(<ProviderLimits />)
			respond([
				{
					providerId: providerIdentifiers.zai,
					ok: true,
					fetchedAt: 1,
					windows: [
						{ id: "a", valueLabel: "5-hour", usedPercent: 40, name: { key: "hours", count: 5 } },
						{ id: "b", valueLabel: "Weekly", usedPercent: 10, name: { key: "weekly" } },
						{ id: "c", valueLabel: "$4.25 left" },
					],
				},
			])

			const bars = screen.getAllByRole("progressbar")
			expect(bars).toHaveLength(2)
			const labels = bars.map((bar) => bar.getAttribute("aria-label"))
			expect(labels[0]).toContain("settings:usage.limits.window.hours 5")
			expect(labels[1]).toContain("settings:usage.limits.window.weekly")
			expect(new Set(labels).size).toBe(2)
			const shown = screen.getByTestId(`provider-limit-${providerIdentifiers.zai}`).querySelector(".font-medium")
			expect(shown?.textContent).toBeTruthy()
			for (const label of labels) expect(label).toContain(shown?.textContent as string)
		})
	})

	describe("window names", () => {
		const quota = (windows: Extract<ProviderQuota, { ok: true }>["windows"]): ProviderQuota => ({
			providerId: providerIdentifiers.zai,
			ok: true,
			windows,
			fetchedAt: 1,
		})

		it.each([
			[{ key: "weekly" }, "settings:usage.limits.window.weekly"],
			[{ key: "unlimited" }, "settings:usage.limits.window.unlimited"],
			[{ key: "hours", count: 5 }, "settings:usage.limits.window.hours 5"],
			[{ key: "days", count: 3 }, "settings:usage.limits.window.days 3"],
		] as const)("translates a window named %j", (name, expected) => {
			render(<ProviderLimits />)
			respond([quota([{ id: "w", valueLabel: "ENGLISH FALLBACK", name }])])

			const row = screen.getByTestId(`provider-limit-${providerIdentifiers.zai}`)
			expect(row.textContent).toContain(expected)
			expect(row.textContent).not.toContain("ENGLISH FALLBACK")
		})

		it("shows the host's text for a window without a fixed name", () => {
			render(<ProviderLimits />)
			respond([quota([{ id: "b", valueLabel: "$4.25 left" }])])

			expect(screen.getByTestId(`provider-limit-${providerIdentifiers.zai}`).textContent).toContain("$4.25 left")
		})
	})

	it("shows a loading row until the first response", () => {
		render(<ProviderLimits />)
		expect(screen.getByTestId("provider-limits")).toBeTruthy()
		expect(screen.queryByTestId(`provider-limit-${providerIdentifiers.githubCopilot}`)).toBeNull()
	})

	it("renders credits with a progress bar and reset date", () => {
		render(<ProviderLimits />)
		respond([
			{
				providerId: providerIdentifiers.githubCopilot,
				ok: true,
				plan: "business",
				fetchedAt: Date.now(),
				windows: [
					{
						id: "premium",
						valueLabel: "39,389.3 / 140,000 used",
						usedPercent: 28.1,
						resetAt: Date.parse("2026-11-01T12:00:00Z"),
					},
				],
			},
		])

		const row = screen.getByTestId(`provider-limit-${providerIdentifiers.githubCopilot}`)
		expect(row.textContent).toContain("GitHub Copilot")
		expect(row.textContent).toContain("business")
		expect(row.textContent).toContain("39,389.3 / 140,000 used")
		expect(row.textContent).toContain("28%")
		const bar = row.querySelector("[role=progressbar]")!
		expect(bar.getAttribute("aria-valuenow")).toBe("28")
		// The translation key plus the formatted reset date, not just the key.
		expect(row.textContent).toContain(
			`settings:usage.limits.resets ${new Date(Date.parse("2026-11-01T12:00:00Z")).toLocaleDateString("en", { dateStyle: "medium" })}`,
		)
	})

	it("omits the bar for balance-only providers", () => {
		render(<ProviderLimits />)
		respond([
			{
				providerId: providerIdentifiers.deepseek,
				ok: true,
				fetchedAt: 1,
				windows: [{ id: "balance", valueLabel: "$4.25 left" }],
			},
		])
		const row = screen.getByTestId(`provider-limit-${providerIdentifiers.deepseek}`)
		expect(row.textContent).toContain("$4.25 left")
		expect(row.querySelector("[role=progressbar]")).toBeNull()
	})

	it("writes the reset date and the updated time in the display language", () => {
		render(<ProviderLimits />)
		const resetAt = new Date(2026, 10, 1, 12, 0).getTime()
		const fetchedAt = new Date(2026, 10, 1, 14, 41).getTime()
		respond([
			{
				providerId: providerIdentifiers.openrouter,
				ok: true,
				fetchedAt,
				windows: [{ id: "key_limit", valueLabel: "x", usedPercent: 10, resetAt }],
			},
		])
		const row = screen.getByTestId(`provider-limit-${providerIdentifiers.openrouter}`)
		expect(row.textContent).toContain(
			`settings:usage.limits.resets ${new Date(resetAt).toLocaleDateString("en", { dateStyle: "medium" })}`,
		)
		expect(screen.getByTestId("provider-limits-refresh").textContent).toContain(
			`settings:usage.limits.updated ${new Date(fetchedAt).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" })}`,
		)
	})

	it.each(["noKey", "noCopilot", "signedOut", "unsupported", "error"] as const)(
		"shows the quiet status text for %s",
		(reason) => {
			render(<ProviderLimits />)
			respond([{ providerId: providerIdentifiers.openrouter, ok: false, reason, fetchedAt: 1 }])
			const row = screen.getByTestId(`provider-limit-${providerIdentifiers.openrouter}`)
			expect(row.textContent).toContain(`settings:usage.limits.${reason}`)
			expect(row.querySelector("[role=progressbar]")).toBeNull()
		},
	)

	it.each([
		[50, "bg-vscode-charts-green"],
		[80, "bg-vscode-charts-yellow"],
		[95, "bg-vscode-charts-red"],
	])("colours the bar by how much of the allowance is used (%i%%)", (usedPercent, expected) => {
		render(<ProviderLimits />)
		respond([
			{
				providerId: providerIdentifiers.openrouter,
				ok: true,
				fetchedAt: 1,
				windows: [{ id: "key_limit", valueLabel: "x", usedPercent }],
			},
		])
		const bar = screen
			.getByTestId(`provider-limit-${providerIdentifiers.openrouter}`)
			.querySelector("[role=progressbar] > div")!
		expect(bar.className).toContain(expected)
	})

	it("treats a response without a providerQuotas list as empty", () => {
		render(<ProviderLimits />)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "providerQuotas", requestId: lastRequestId() } }),
			)
		})
		expect(screen.queryByTestId("provider-limits")).toBeNull()
	})

	it("hides the whole section when nothing connected has a usage API", () => {
		render(<ProviderLimits />)
		respond([])
		expect(screen.queryByTestId("provider-limits")).toBeNull()
	})

	it("refresh forces a new request", () => {
		render(<ProviderLimits />)
		respond([
			{
				providerId: providerIdentifiers.deepseek,
				ok: true,
				fetchedAt: 1,
				windows: [{ id: "b", valueLabel: "$1.00 left" }],
			},
		])
		post.mockClear()
		fireEvent.click(screen.getByTestId("provider-limits-refresh"))
		expect(post).toHaveBeenCalledWith({
			type: "requestProviderQuotas",
			bool: true,
			requestId: expect.stringMatching(/^provider-quotas-[a-z0-9]+-\d+$/),
		})
	})

	it("ignores unrelated messages", () => {
		render(<ProviderLimits />)
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "somethingElse" } }))
		})
		expect(screen.getByTestId("provider-limits")).toBeTruthy()
	})

	describe("request lifecycle", () => {
		const ok = (providerId: string = providerIdentifiers.deepseek): ProviderQuota => ({
			providerId,
			ok: true,
			fetchedAt: 1,
			windows: [{ id: "b", valueLabel: "$1.00 left" }],
		})

		it("ignores an answer for a request that a refresh has overtaken", () => {
			render(<ProviderLimits />)
			const first = lastRequestId()
			respond([ok(providerIdentifiers.deepseek)])
			fireEvent.click(screen.getByTestId("provider-limits-refresh"))
			const second = lastRequestId()
			expect(second).not.toBe(first)

			// A late answer to the first request must not replace the newer state or end the spinner.
			respond([ok(providerIdentifiers.moonshot)], first)
			expect(screen.queryByTestId(`provider-limit-${providerIdentifiers.moonshot}`)).toBeNull()
			expect(screen.getByTestId("provider-limits-refresh").hasAttribute("disabled")).toBe(true)

			respond([ok(providerIdentifiers.moonshot)], second)
			expect(screen.getByTestId(`provider-limit-${providerIdentifiers.moonshot}`)).toBeTruthy()
			expect(screen.getByTestId("provider-limits-refresh").hasAttribute("disabled")).toBe(false)
		})

		it("ignores an answer that carries no request id or an unknown one", () => {
			render(<ProviderLimits />)
			respond([ok()], null)
			respond([ok()], "provider-quotas-999")
			expect(screen.queryByTestId(`provider-limit-${providerIdentifiers.deepseek}`)).toBeNull()
		})

		it("does not offer a refresh while a request is pending, so a newer one never races an older one", () => {
			render(<ProviderLimits />)
			expect(screen.getByTestId("provider-limits-refresh").hasAttribute("disabled")).toBe(true)
			post.mockClear()
			fireEvent.click(screen.getByTestId("provider-limits-refresh"))
			expect(post).not.toHaveBeenCalled()
		})

		it("cancels the in-flight request on unmount and ignores a late answer", () => {
			const { unmount } = render(<ProviderLimits />)
			const pending = lastRequestId()
			post.mockClear()
			unmount()
			expect(post).toHaveBeenCalledWith({ type: "cancelProviderQuotas", requestId: pending })
			// Must not throw or update state after unmount.
			expect(() => respond([ok()], pending)).not.toThrow()
		})

		it("does not cancel a request that has already been answered", () => {
			const { unmount } = render(<ProviderLimits />)
			respond([ok()])
			post.mockClear()
			unmount()
			expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancelProviderQuotas" }))
		})
	})

	describe("a failed load", () => {
		const respondFailed = () =>
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "providerQuotas",
							providerQuotas: [],
							providerQuotasFailed: true,
							requestId: lastRequestId(),
						},
					}),
				)
			})

		it("keeps the section and says so, instead of hiding it like 'no provider has a usage API'", () => {
			render(<ProviderLimits />)
			respondFailed()
			expect(screen.getByTestId("provider-limits")).toBeTruthy()
			expect(screen.getByTestId("provider-limits-failed").textContent).toContain("settings:usage.limits.error")
		})

		it("lets the user retry, and clears the failure when the retry works", () => {
			render(<ProviderLimits />)
			respondFailed()

			const before = lastRequestId()
			post.mockClear()
			fireEvent.click(screen.getByTestId("provider-limits-refresh"))
			expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "requestProviderQuotas", bool: true }))
			expect(lastRequestId()).not.toBe(before)

			respond([
				{
					providerId: providerIdentifiers.deepseek,
					ok: true,
					fetchedAt: 1,
					windows: [{ id: "b", valueLabel: "$1.00 left" }],
				},
			])
			expect(screen.queryByTestId("provider-limits-failed")).toBeNull()
			expect(screen.getByTestId(`provider-limit-${providerIdentifiers.deepseek}`)).toBeTruthy()
		})

		it("still hides the section when the load worked and nothing has a usage API", () => {
			render(<ProviderLimits />)
			respond([])
			expect(screen.queryByTestId("provider-limits")).toBeNull()
		})
	})

	it("makes ids that differ between webviews, not just between requests", async () => {
		// Each webview loads its own copy of the module and starts counting again from 1.
		vi.resetModules()
		const { ProviderLimits: First } = await import("../ProviderLimits")
		const first = lastRequestIdAfterRender(First)
		vi.resetModules()
		const { ProviderLimits: Second } = await import("../ProviderLimits")
		const second = lastRequestIdAfterRender(Second)

		expect(first).toMatch(/^provider-quotas-[a-z0-9]+-1$/)
		expect(second).toMatch(/^provider-quotas-[a-z0-9]+-1$/)
		// Same counter value, still different ids: the session part tells the webviews apart.
		expect(first).not.toBe(second)
	})

	it("never reuses a request id when the tab is closed and opened again", () => {
		const first = render(<ProviderLimits />)
		const firstId = lastRequestId()
		first.unmount()

		render(<ProviderLimits />)
		expect(lastRequestId()).not.toBe(firstId)
	})
})
