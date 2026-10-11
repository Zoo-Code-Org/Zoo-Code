import * as vscode from "vscode"

import { canCreateImageParts, createImagePart } from "../vscode-lm-image-part"

vi.mock("vscode", () => ({ LanguageModelChatMessage: { User: vi.fn() }, LanguageModelDataPart: undefined }))

// The stable typings predate image parts, so tests install and remove the host's class by name.
const setHostImagePart = (value: unknown) => Object.assign(vscode, { LanguageModelDataPart: value })

describe("image part support detection", () => {
	afterEach(() => setHostImagePart(undefined))

	it("builds image parts through the host's factory", () => {
		const image = vi.fn((data: Uint8Array, mimeType: string) => ({ data, mimeType }))
		setHostImagePart(
			class {
				static image = image
			},
		)
		const bytes = new Uint8Array([1, 2])

		expect(canCreateImageParts()).toBe(true)
		expect(createImagePart(bytes, "image/png")).toEqual({ data: bytes, mimeType: "image/png" })
		expect(image).toHaveBeenCalledWith(bytes, "image/png")
	})

	it.each([
		["a host without image parts", undefined],
		["a host whose image part has no factory", class {}],
		["a host that exposes something other than a class", { image: () => ({}) }],
		[
			"a host whose factory is not callable",
			class {
				static image = "nope"
			},
		],
	])("cannot create image parts on %s", (_label, hostValue) => {
		setHostImagePart(hostValue)

		expect(canCreateImageParts()).toBe(false)
		expect(createImagePart(new Uint8Array(), "image/png")).toBeUndefined()
	})

	it("re-checks the host on every call, since the host and not this bundle decides support", () => {
		expect(canCreateImageParts()).toBe(false)
		setHostImagePart(
			class {
				static image = () => ({})
			},
		)
		expect(canCreateImageParts()).toBe(true)
	})
})
