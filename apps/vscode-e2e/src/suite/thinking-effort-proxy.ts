import { createServer, type IncomingMessage, type ServerResponse } from "http"

/**
 * Shared loopback capture proxy for the DTE e2e suites
 * (thinking-effort-tool / thinking-effort-switching).
 *
 * Pattern from anthropic-opus-4-7.test.ts: it intercepts the
 * OpenRouter-compatible chat/completions POST so request shapes can be
 * asserted (model, reasoning envelope, message content), then forwards the
 * request unchanged to the upstream — aimock in replay/record mode — which
 * answers with the fixture-driven SSE.
 */

export type DteReasoningEnvelope = {
	effort?: string
	max_tokens?: number
	exclude?: boolean
}

export type CapturedDteRequest = {
	model?: string
	reasoning: DteReasoningEnvelope | undefined
	/** Raw JSON body, so assertions can inspect any part of the wire request (e.g. tool result text). */
	bodyText: string
	lastUserMessage: string
}

type OpenRouterChatCompletionBody = {
	model?: string
	reasoning?: DteReasoningEnvelope
	messages?: Array<{ role?: string; content?: unknown }>
}

const ALLOWED_PROXY_HOSTS = new Set(["127.0.0.1", "localhost"])
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-connection",
	"proxy-authenticate",
	"proxy-authorization",
	"host",
	"content-length",
])

/**
 * Whether a raw URL targets the OpenRouter-compatible chat/completions endpoint.
 */
function isChatCompletionsUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).pathname.endsWith(CHAT_COMPLETIONS_PATH)
	} catch {
		return false
	}
}

/**
 * Collects the full request body as a UTF-8 string.
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

/**
 * Mirrors the upstream response headers onto the proxy response, dropping the
 * headers that would break fetch()-decoded streaming (content-encoding / length).
 */
function writeResponseHeaders(target: ServerResponse, source: Response) {
	const headers: Record<string, string> = {}
	source.headers.forEach((value, key) => {
		const lower = key.toLowerCase()
		// fetch() automatically decompresses the body, so strip content-encoding to
		// prevent the SDK from attempting a second decompression. Also strip
		// content-length since the decoded body length differs from the compressed one.
		if (lower !== "content-length" && lower !== "content-encoding") {
			headers[key] = value
		}
	})
	target.writeHead(source.status, headers)
}

/**
 * Streams the upstream (already-decoded) fetch body through to the proxy
 * response, ending the response when the body completes.
 */
async function pipeFetchResponse(target: ServerResponse, source: Response) {
	writeResponseHeaders(target, source)

	if (!source.body) {
		target.end()
		return
	}

	const reader = source.body.getReader()
	while (true) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		target.write(value)
	}

	target.end()
}

/**
 * Resolves the upstream chat/completions URL, rejecting any target that is not
 * a loopback HTTP origin (the proxy must never forward to a real endpoint).
 */
function resolveAllowedUpstreamUrl(baseUrl: string): URL {
	const upstreamBase = new URL(baseUrl)

	if (!ALLOWED_PROXY_HOSTS.has(upstreamBase.hostname) || upstreamBase.protocol !== "http:") {
		throw new Error("Unexpected OpenRouter proxy target: " + upstreamBase.origin)
	}

	return new URL(CHAT_COMPLETIONS_PATH, upstreamBase)
}

/**
 * Serves a loopback capture proxy for the OpenRouter-compatible
 * chat/completions endpoint: captures each request body for assertions and
 * forwards it unchanged to the upstream (aimock in replay/record mode).
 */
export async function withOpenRouterCaptureProxy<T>(
	upstreamUrl: string,
	run: (args: { proxyUrl: string; requests: CapturedDteRequest[] }) => Promise<T>,
): Promise<T> {
	const requests: CapturedDteRequest[] = []
	const upstreamTarget = resolveAllowedUpstreamUrl(upstreamUrl)
	let proxyError: Error | undefined

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = req.url ?? "/"

			if (!isChatCompletionsUrl("http://127.0.0.1" + requestUrl)) {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			const bodyText = await readRequestBody(req)
			const body = JSON.parse(bodyText) as OpenRouterChatCompletionBody
			const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")
			const lastUserMessage =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")

			requests.push({
				model: body.model,
				reasoning: body.reasoning,
				bodyText,
				lastUserMessage,
			})

			const forwardHeaders: Record<string, string> = {}
			for (const [key, value] of Object.entries(req.headers)) {
				if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
					forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value
				}
			}

			const upstream = await fetch(upstreamTarget, {
				method: req.method,
				headers: forwardHeaders,
				body: bodyText,
			})

			await pipeFetchResponse(res, upstream)
		} catch (error) {
			proxyError = error instanceof Error ? error : new Error(String(error))
			console.error("OpenRouter proxy request failed:", proxyError)
			if (!res.headersSent) {
				res.writeHead(502)
				res.end("Capture proxy error")
			} else if (!res.writableEnded) {
				res.destroy()
			}
		}
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve())
	})

	const address = server.address()
	if (address === null || typeof address === "string") {
		server.close()
		throw new Error("Capture proxy failed to bind a loopback port")
	}

	const proxyUrl = "http://127.0.0.1:" + address.port

	try {
		const result = await run({ proxyUrl, requests })
		if (proxyError) {
			throw proxyError
		}
		return result
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	}
}
