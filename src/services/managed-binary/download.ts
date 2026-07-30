import { createHash } from "crypto"
import { createReadStream, createWriteStream } from "fs"
import * as https from "https"

export interface BinaryDownloadOptions {
	name: string
	trustedDomains: readonly string[]
	timeoutMs: number
	maxBytes?: number
	maxRedirects?: number
	exclusiveDestination?: boolean
}

export function isTrustedHttpsUrl(url: string, trustedDomains: readonly string[]): boolean {
	try {
		const parsed = new URL(url)
		return (
			parsed.protocol === "https:" &&
			trustedDomains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))
		)
	} catch {
		return false
	}
}

export function resolveTrustedRedirect(
	url: string,
	location: string | undefined,
	redirectsRemaining: number,
	options: Pick<BinaryDownloadOptions, "name" | "trustedDomains">,
): string {
	if (redirectsRemaining <= 0 || !location) {
		throw new Error(`Too many ${options.name} download redirects`)
	}

	const nextUrl = new URL(location, url).toString()
	if (!isTrustedHttpsUrl(nextUrl, options.trustedDomains)) {
		throw new Error(`${options.name} download redirected to an untrusted host (untrusted domain)`)
	}

	return nextUrl
}

export function assertSizeWithinLimit(size: number, maxBytes: number, name: string): void {
	if (size > maxBytes) {
		throw new Error(`${name} archive exceeds the download size limit`)
	}
}

export async function verifySha256Checksum(
	filePath: string,
	expected: string,
	createMismatchError: (actual: string) => Error,
): Promise<void> {
	const hash = createHash("sha256")
	await new Promise<void>((resolve, reject) => {
		const input = createReadStream(filePath)
		input.on("data", (chunk) => hash.update(chunk))
		input.on("end", resolve)
		input.on("error", reject)
	})

	const actual = hash.digest("hex")
	if (actual !== expected) {
		throw createMismatchError(actual)
	}
}

export function downloadBinaryFile(url: string, destination: string, options: BinaryDownloadOptions): Promise<void> {
	return downloadBinaryFileWithRedirects(url, destination, options, options.maxRedirects ?? 5)
}

function downloadBinaryFileWithRedirects(
	url: string,
	destination: string,
	options: BinaryDownloadOptions,
	redirectsRemaining: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!isTrustedHttpsUrl(url, options.trustedDomains)) {
			reject(new Error(`${options.name} download redirected to an untrusted host (untrusted domain)`))
			return
		}

		const request = https.get(url, (response) => {
			const status = response.statusCode ?? 0
			if ([301, 302, 303, 307, 308].includes(status)) {
				response.destroy()
				let nextUrl: string
				try {
					nextUrl = resolveTrustedRedirect(url, response.headers.location, redirectsRemaining, options)
				} catch (error) {
					reject(error)
					return
				}
				downloadBinaryFileWithRedirects(nextUrl, destination, options, redirectsRemaining - 1).then(
					resolve,
					reject,
				)
				return
			}

			if (status !== 200) {
				response.destroy()
				reject(new Error(`${options.name} download failed with HTTP ${status}`))
				return
			}

			const declaredSize = Number(response.headers["content-length"] ?? 0)
			if (options.maxBytes !== undefined) {
				try {
					assertSizeWithinLimit(declaredSize, options.maxBytes, options.name)
				} catch (error) {
					response.destroy()
					reject(error)
					return
				}
			}

			let received = 0
			const output = createWriteStream(
				destination,
				options.exclusiveDestination ? { flags: "wx", mode: 0o600 } : undefined,
			)
			response.on("data", (chunk: Buffer) => {
				received += chunk.length
				if (options.maxBytes !== undefined) {
					try {
						assertSizeWithinLimit(received, options.maxBytes, options.name)
					} catch (error) {
						response.destroy()
						request.destroy(error as Error)
						reject(error)
					}
				}
			})
			response.on("error", reject)
			response.pipe(output)
			output.on("finish", () => {
				output.close()
				resolve()
			})
			output.on("error", reject)
		})

		request.setTimeout(options.timeoutMs, () => request.destroy(new Error(`${options.name} download timed out`)))
		request.on("error", reject)
	})
}
