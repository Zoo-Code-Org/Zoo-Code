import { EventEmitter } from "events"
import { createReadStream, createWriteStream } from "fs"
import { get } from "https"
import type { IncomingMessage, RequestOptions } from "http"

import {
	assertSizeWithinLimit,
	downloadBinaryFile,
	isTrustedHttpsUrl,
	resolveTrustedRedirect,
	verifySha256Checksum,
} from "../download"

vi.mock("crypto", () => ({
	createHash: vi.fn(() => ({
		update: vi.fn(),
		digest: vi.fn(() => "actual-checksum"),
	})),
}))

vi.mock("fs", () => ({
	createReadStream: vi.fn(),
	createWriteStream: vi.fn(),
}))

vi.mock("https", () => ({ get: vi.fn() }))

const trustedDomains = ["github.com", "objects.githubusercontent.com"]
const mockGet = vi.mocked(get)
const mockCreateReadStream = vi.mocked(createReadStream)
const mockCreateWriteStream = vi.mocked(createWriteStream)

function createRequest(): EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
	return Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
}

function createResponse(statusCode: number, headers: Record<string, string> = {}) {
	return Object.assign(new EventEmitter(), {
		statusCode,
		headers,
		destroy: vi.fn(),
		pipe: vi.fn(),
		unpipe: vi.fn(),
	})
}

describe("managed binary downloads", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("validates HTTPS URLs against hostname boundaries", () => {
		expect(isTrustedHttpsUrl("https://github.com/release", trustedDomains)).toBe(true)
		expect(isTrustedHttpsUrl("https://cdn.objects.githubusercontent.com/release", trustedDomains)).toBe(true)
		expect(isTrustedHttpsUrl("http://github.com/release", trustedDomains)).toBe(false)
		expect(isTrustedHttpsUrl("https://evilgithub.com/release", trustedDomains)).toBe(false)
		expect(isTrustedHttpsUrl("not a URL", trustedDomains)).toBe(false)
	})

	it("resolves relative redirects and rejects unsafe or exhausted redirects", () => {
		const options = { name: "Example", trustedDomains }
		expect(resolveTrustedRedirect("https://github.com/release", "/asset", 5, options)).toBe(
			"https://github.com/asset",
		)
		expect(() =>
			resolveTrustedRedirect("https://github.com/release", "https://example.com/asset", 5, options),
		).toThrow("Example download redirected to an untrusted host")
		expect(() => resolveTrustedRedirect("https://github.com/release", "/asset", 0, options)).toThrow(
			"Too many Example download redirects",
		)
		expect(() => resolveTrustedRedirect("https://github.com/release", undefined, 5, options)).toThrow(
			"Example download redirect is missing a Location header",
		)
	})

	it("distinguishes an untrusted initial URL from an unsafe redirect", async () => {
		await expect(
			downloadBinaryFile("http://github.com/release", "/tmp/archive", {
				name: "Example",
				trustedDomains,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow("Example download URL is not a trusted HTTPS host")
		expect(mockGet).not.toHaveBeenCalled()
	})

	it("enforces configurable archive size limits", () => {
		expect(() => assertSizeWithinLimit(10, 10, "Example")).not.toThrow()
		expect(() => assertSizeWithinLimit(11, 10, "Example")).toThrow(
			"Example archive exceeds the download size limit",
		)
	})

	it("reports the actual SHA-256 value through a caller-defined mismatch error", async () => {
		const input = new EventEmitter()
		mockCreateReadStream.mockReturnValue(input as ReturnType<typeof createReadStream>)
		const verification = verifySha256Checksum(
			"/tmp/archive",
			"expected-checksum",
			(actual) => new Error(`checksum mismatch: ${actual}`),
		)
		input.emit("data", Buffer.from("archive"))
		input.emit("end")
		await expect(verification).rejects.toThrow("checksum mismatch: actual-checksum")
	})

	it("accepts a matching SHA-256 checksum", async () => {
		const input = new EventEmitter()
		mockCreateReadStream.mockReturnValue(input as ReturnType<typeof createReadStream>)
		const verification = verifySha256Checksum("/tmp/archive", "actual-checksum", () => new Error("should not fail"))
		input.emit("data", Buffer.from("archive"))
		input.emit("end")

		await expect(verification).resolves.toBeUndefined()
	})

	it("follows a trusted redirect and applies destination security options", async () => {
		const requestOne = createRequest()
		const requestTwo = createRequest()
		const redirect = createResponse(302, { location: "/asset" })
		const success = createResponse(200, { "content-length": "7" })
		const output = Object.assign(new EventEmitter(), { close: vi.fn() })
		mockCreateWriteStream.mockReturnValue(output as unknown as ReturnType<typeof createWriteStream>)

		mockGet
			.mockImplementationOnce((_url, optionsOrCallback, optionalCallback) => {
				const callback =
					typeof optionsOrCallback === "function"
						? optionsOrCallback
						: (optionalCallback as ((response: IncomingMessage) => void) | undefined)
				setImmediate(() => callback?.(redirect as unknown as IncomingMessage))
				return requestOne as unknown as ReturnType<typeof get>
			})
			.mockImplementationOnce((_url, optionsOrCallback, optionalCallback) => {
				const callback =
					typeof optionsOrCallback === "function"
						? optionsOrCallback
						: (optionalCallback as ((response: IncomingMessage) => void) | undefined)
				setImmediate(() => callback?.(success as unknown as IncomingMessage))
				return requestTwo as unknown as ReturnType<typeof get>
			})

		const download = downloadBinaryFile("https://github.com/release", "/tmp/archive", {
			name: "Example",
			trustedDomains,
			timeoutMs: 1_000,
			maxBytes: 10,
			exclusiveDestination: true,
		})
		await new Promise<void>((resolve) => setImmediate(resolve))
		await new Promise<void>((resolve) => setImmediate(resolve))
		let resolved = false
		void download.then(() => {
			resolved = true
		})
		output.emit("finish")
		await Promise.resolve()
		expect(resolved).toBe(false)
		output.emit("close")
		await download

		expect(mockGet).toHaveBeenNthCalledWith(2, "https://github.com/asset", expect.any(Function))
		expect(mockCreateWriteStream).toHaveBeenCalledWith("/tmp/archive", { flags: "wx", mode: 0o600 })
		expect(requestOne.setTimeout).toHaveBeenCalledWith(1_000, expect.any(Function))
		expect(requestTwo.setTimeout).toHaveBeenCalledWith(1_000, expect.any(Function))
	})

	it("rejects an oversized declared response before opening the destination", async () => {
		const request = createRequest()
		const response = createResponse(200, { "content-length": "11" })
		mockGet.mockImplementation(
			(
				_url: string | URL,
				optionsOrCallback: RequestOptions | ((response: IncomingMessage) => void),
				optionalCallback?: (response: IncomingMessage) => void,
			) => {
				const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback
				setImmediate(() => callback?.(response as unknown as IncomingMessage))
				return request as unknown as ReturnType<typeof get>
			},
		)

		await expect(
			downloadBinaryFile("https://github.com/release", "/tmp/archive", {
				name: "Example",
				trustedDomains,
				timeoutMs: 1_000,
				maxBytes: 10,
			}),
		).rejects.toThrow("Example archive exceeds the download size limit")
		expect(mockCreateWriteStream).not.toHaveBeenCalled()
	})

	it("unpipes and destroys the destination when streamed bytes exceed the limit", async () => {
		const request = createRequest()
		const response = createResponse(200)
		const output = Object.assign(new EventEmitter(), { close: vi.fn(), destroy: vi.fn() })
		mockCreateWriteStream.mockReturnValue(output as unknown as ReturnType<typeof createWriteStream>)
		mockGet.mockImplementation((_url, optionsOrCallback, optionalCallback) => {
			const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback
			setImmediate(() => callback?.(response as unknown as IncomingMessage))
			return request as unknown as ReturnType<typeof get>
		})

		const download = downloadBinaryFile("https://github.com/release", "/tmp/archive", {
			name: "Example",
			trustedDomains,
			timeoutMs: 1_000,
			maxBytes: 10,
		})
		await new Promise<void>((resolve) => setImmediate(resolve))
		response.emit("data", Buffer.alloc(11))

		await expect(download).rejects.toThrow("Example archive exceeds the download size limit")
		expect(response.unpipe).toHaveBeenCalledWith(output)
		expect(output.destroy).toHaveBeenCalledOnce()
		expect(response.destroy).toHaveBeenCalledOnce()
		expect(request.destroy).toHaveBeenCalledOnce()
	})
})
