import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useHostSyncedForm } from "../useHostSyncedForm"

type Host = { a: boolean; b: string; list: string[] }

const initialHost: Host = { a: true, b: "one", list: ["x"] }

const renderForm = (host: Host = initialHost) =>
	renderHook(({ host }: { host: Host }) => useHostSyncedForm(host), { initialProps: { host } })

describe("useHostSyncedForm", () => {
	it("starts with the host state", () => {
		const { result } = renderForm()

		expect(result.current.form).toEqual(initialHost)
	})

	it.each<[keyof Host, Host[keyof Host]]>([
		["a", false],
		["b", "two"],
		["list", ["y"]],
	])("an untouched field %s follows a host change", (key, value) => {
		const { result, rerender } = renderForm()

		rerender({ host: { ...initialHost, [key]: value } })

		expect(result.current.form[key]).toEqual(value)
		expect(result.current.isTouched(key)).toBe(false)
	})

	it("a touched field keeps the user's value through a host change, and other fields still follow", () => {
		const { result, rerender } = renderForm()

		act(() => result.current.setField("b", "edited"))
		rerender({ host: { ...initialHost, a: false, b: "from host" } })

		expect(result.current.form).toEqual({ a: false, b: "edited", list: ["x"] })
		expect(result.current.isTouched("b")).toBe(true)
	})

	it("setting a field to its current value does not touch it", () => {
		const { result, rerender } = renderForm()

		act(() => result.current.setField("b", "one"))
		rerender({ host: { ...initialHost, b: "from host" } })

		expect(result.current.isTouched("b")).toBe(false)
		expect(result.current.form.b).toBe("from host")
	})

	it("updateField computes the value from the current one", () => {
		const { result } = renderForm()

		act(() => result.current.updateField("list", (prev) => [...prev, "y"]))

		expect(result.current.form.list).toEqual(["x", "y"])
		expect(result.current.isTouched("list")).toBe(true)
	})

	it("markSaved untouches only the fields whose value still matches what was sent", () => {
		const { result, rerender } = renderForm()

		act(() => {
			result.current.setField("a", false)
			result.current.setField("b", "sent")
		})
		const sent = result.current.form
		act(() => result.current.setField("b", "edited after send"))

		let clean = true
		act(() => {
			clean = result.current.markSaved(sent, result.current.form)
		})

		expect(clean).toBe(false)
		expect(result.current.isTouched("a")).toBe(false)
		expect(result.current.isTouched("b")).toBe(true)

		// The untouched field follows the host again; the field edited after the send keeps the user's value.
		rerender({ host: { ...initialHost, a: false, b: "sent" } }) // the host stores the save
		rerender({ host: { ...initialHost, a: true, b: "from host" } }) // another view changes both fields
		expect(result.current.form.a).toBe(true)
		expect(result.current.form.b).toBe("edited after send")
	})

	it("markSaved returns true when no field stays touched", () => {
		const { result } = renderForm()

		act(() => result.current.setField("a", false))
		const sent = result.current.form

		expect(result.current.markSaved(sent, sent)).toBe(true)
		expect(result.current.isTouched("a")).toBe(false)
	})

	it("a saved field keeps the saved value until the host reports a change", () => {
		const { result, rerender } = renderForm()

		act(() => result.current.setField("a", false))
		act(() => {
			result.current.markSaved(result.current.form, result.current.form)
		})
		// A new host object with the old values (the host has not stored the save yet) does not revert the form.
		rerender({ host: { ...initialHost } })

		expect(result.current.form.a).toBe(false)
	})

	it("a saved array is not reverted by a copied, unchanged host array, and follows a real host change", () => {
		const { result, rerender } = renderForm()

		act(() => result.current.setField("list", ["x", "y"]))
		act(() => {
			result.current.markSaved(result.current.form, result.current.form)
		})

		rerender({ host: { ...initialHost, list: ["x"] } })
		expect(result.current.form.list).toEqual(["x", "y"])

		rerender({ host: { ...initialHost, list: ["x", "y"] } }) // the host stores the save
		expect(result.current.form.list).toEqual(["x", "y"])

		rerender({ host: { ...initialHost, list: ["z"] } }) // another view changes the list
		expect(result.current.form.list).toEqual(["z"])
	})

	it("edits batched before a reset do not stay touched after it", () => {
		const { result, rerender } = renderForm()

		act(() => {
			result.current.setField("a", false)
			result.current.setField("b", "edited")
			result.current.reset()
		})

		expect(result.current.form).toEqual(initialHost)
		expect(result.current.isTouched("a")).toBe(false)
		expect(result.current.isTouched("b")).toBe(false)
		rerender({ host: { ...initialHost, b: "from host" } })
		expect(result.current.form.b).toBe("from host")
	})

	it("edits batched without a reset all apply and stay touched", () => {
		const { result } = renderForm()

		act(() => {
			result.current.updateField("list", (prev) => [...prev, "y"])
			result.current.updateField("list", (prev) => [...prev, "z"])
			result.current.setField("b", "edited")
		})

		expect(result.current.form).toEqual({ a: true, b: "edited", list: ["x", "y", "z"] })
		expect(result.current.isTouched("list")).toBe(true)
		expect(result.current.isTouched("b")).toBe(true)
	})

	describe("host changes to a touched field around a save", () => {
		const edit = (view: ReturnType<typeof renderForm>) => {
			act(() => view.result.current.setField("b", "sent"))
			return view.result.current.form
		}
		const push = (view: ReturnType<typeof renderForm>, b: string) => view.rerender({ host: { ...initialHost, b } })
		const acknowledge = (view: ReturnType<typeof renderForm>, sent: Host) =>
			act(() => {
				view.result.current.markSaved(sent, view.result.current.form)
			})

		it.each([
			["another value", ["sent", "from another view"]],
			["the value from before the edit", ["sent", "one"]],
		])("after the send, the form takes the latest host value: %s", (_name, pushes) => {
			const view = renderForm()
			const sent = edit(view)
			act(() => view.result.current.markSent())
			pushes.forEach((b) => push(view, b))
			expect(view.result.current.form.b).toBe("sent") // the save is not acknowledged yet

			acknowledge(view, sent)

			expect(view.result.current.form.b).toBe(pushes.at(-1))
			expect(view.result.current.isTouched("b")).toBe(false)
		})

		it("before the send, the sent value wins and does not flicker before the host reports the save", () => {
			const view = renderForm()
			const sent = edit(view)
			push(view, "from another view")
			act(() => view.result.current.markSent())

			acknowledge(view, sent)

			expect(view.result.current.form.b).toBe("sent")
		})

		it("the host's report of the save alone keeps the form object", () => {
			const view = renderForm()
			const sent = edit(view)
			act(() => view.result.current.markSent())
			push(view, "sent")

			acknowledge(view, sent)

			expect(view.result.current.form).toBe(sent)
		})

		it("a field edited again after the send keeps the new edit", () => {
			const view = renderForm()
			const sent = edit(view)
			act(() => view.result.current.markSent())
			push(view, "from another view")
			act(() => view.result.current.setField("b", "edited again"))

			acknowledge(view, sent)

			expect(view.result.current.form.b).toBe("edited again")
			expect(view.result.current.isTouched("b")).toBe(true)
		})

		it("a reset forgets host changes from before it", () => {
			const view = renderForm()
			edit(view)
			push(view, "from another view")
			act(() => view.result.current.reset())
			const sent = edit(view)

			acknowledge(view, sent)

			expect(view.result.current.form.b).toBe("sent")
		})
	})

	it("reset reloads the form from the host and clears touched fields", () => {
		const { result, rerender } = renderForm()

		act(() => result.current.setField("b", "edited"))
		const latestHost = { ...initialHost, a: false, b: "from host" }
		rerender({ host: latestHost })
		act(() => result.current.reset())

		expect(result.current.form).toBe(latestHost)
		expect(result.current.isTouched("b")).toBe(false)
	})

	it.each([
		["the same host object", (host: Host) => host],
		["a new host object with the same values", (host: Host) => ({ ...host })],
	])("%s does not create a new form object", (_name, nextHost) => {
		const { result, rerender } = renderForm()
		const before = result.current.form

		rerender({ host: nextHost(initialHost) })

		expect(result.current.form).toBe(before)
	})
})
