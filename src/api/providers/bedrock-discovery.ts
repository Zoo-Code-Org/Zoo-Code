import {
	BedrockClient,
	ListFoundationModelsCommand,
	ListInferenceProfilesCommand,
	type BedrockClientConfig,
	type FoundationModelSummary,
	type InferenceProfileSummary,
} from "@aws-sdk/client-bedrock"
import { BedrockRuntimeClient, ConverseCommand, type BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime"
import { fromIni } from "@aws-sdk/credential-providers"

import {
	type BedrockDiscoveredTarget,
	type ProviderSettings,
	expandBedrockTargetsWith1MVariants,
	inferBedrockInvokeTargetKind,
	parseBedrockArn,
	parseBedrockBaseModelId,
	resolveBedrockModelInfo,
} from "@roo-code/types"

import { Package } from "../../shared/package"

// The two AWS SDK packages we use here (`@aws-sdk/client-bedrock` for control-plane discovery
// and `@aws-sdk/client-bedrock-runtime` for Converse probes) each ship their own discriminated
// `Config` interface where `token`/`credentials` are tagged with package-private branded types.
// A shared generic helper struggles to satisfy both, so we keep the auth plumbing inline at
// each call site - the duplication is small and the alternative requires `as` casts that hide
// real type errors.
const toBedrockClientConfig = (options: ProviderSettings): BedrockClientConfig => {
	const config: BedrockClientConfig = {
		userAgentAppId: `RooCode#${Package.version}`,
		region: options.awsRegion,
	}

	if (options.awsUseApiKey && options.awsApiKey) {
		config.token = { token: options.awsApiKey }
		config.authSchemePreference = ["httpBearerAuth"]
	} else if (options.awsUseProfile && options.awsProfile) {
		config.credentials = fromIni({
			profile: options.awsProfile,
			ignoreCache: true,
		})
	} else if (options.awsAccessKey && options.awsSecretKey) {
		config.credentials = {
			accessKeyId: options.awsAccessKey,
			secretAccessKey: options.awsSecretKey,
			...(options.awsSessionToken ? { sessionToken: options.awsSessionToken } : {}),
		}
	}

	return config
}

const toBedrockRuntimeClientConfig = (options: ProviderSettings): BedrockRuntimeClientConfig => {
	const config: BedrockRuntimeClientConfig = {
		userAgentAppId: `RooCode#${Package.version}`,
		region: options.awsRegion,
		...(options.awsBedrockEndpoint &&
			options.awsBedrockEndpointEnabled && { endpoint: options.awsBedrockEndpoint }),
	}

	if (options.awsUseApiKey && options.awsApiKey) {
		config.token = { token: options.awsApiKey }
		config.authSchemePreference = ["httpBearerAuth"]
	} else if (options.awsUseProfile && options.awsProfile) {
		config.credentials = fromIni({
			profile: options.awsProfile,
			ignoreCache: true,
		})
	} else if (options.awsAccessKey && options.awsSecretKey) {
		config.credentials = {
			accessKeyId: options.awsAccessKey,
			secretAccessKey: options.awsSecretKey,
			...(options.awsSessionToken ? { sessionToken: options.awsSessionToken } : {}),
		}
	}

	return config
}

const buildFoundationTarget = (summary: FoundationModelSummary): BedrockDiscoveredTarget | undefined => {
	const targetId = summary.modelId
	if (!targetId) {
		return undefined
	}

	const resolved = resolveBedrockModelInfo({ baseModelId: targetId, targetId })
	const parsedArn = parseBedrockArn(summary.modelArn)

	return {
		id: targetId,
		label: summary.modelName ? `${summary.modelName} (${targetId})` : targetId,
		baseModelId: resolved.baseModelId,
		targetKind: "foundation-model",
		contextWindow: resolved.info.contextWindow,
		contextSource: resolved.contextSource,
		description: summary.providerName,
		arn: summary.modelArn,
		region: parsedArn.region,
		isGlobal: false,
		isCrossRegion: false,
		supportsImages: resolved.info.supportsImages,
		supportsPromptCache: resolved.info.supportsPromptCache,
	}
}

const buildInferenceProfileTarget = (summary: InferenceProfileSummary): BedrockDiscoveredTarget | undefined => {
	const targetId = summary.inferenceProfileId
	if (!targetId) {
		return undefined
	}

	const baseModelIds = Array.from(
		new Set(
			(summary.models ?? [])
				.map((model) => model.modelArn)
				.filter((modelArn): modelArn is string => Boolean(modelArn))
				.map((modelArn) => parseBedrockBaseModelId(modelArn)),
		),
	)
	const baseModelId = baseModelIds[0] ?? parseBedrockBaseModelId(targetId)
	if (!baseModelId) {
		return undefined
	}

	const resolved = resolveBedrockModelInfo({ baseModelId, targetId })
	const targetKind = inferBedrockInvokeTargetKind({
		targetId,
		explicitKind: summary.type === "SYSTEM_DEFINED" ? "system-profile" : "application-profile",
	})
	const parsedArn = parseBedrockArn(summary.inferenceProfileArn)

	return {
		id: targetId,
		label: summary.inferenceProfileName ? `${summary.inferenceProfileName} (${targetId})` : targetId,
		baseModelId: resolved.baseModelId,
		targetKind:
			targetKind === "system-profile" || targetKind === "application-profile"
				? targetKind
				: "application-profile",
		contextWindow: resolved.info.contextWindow,
		contextSource: resolved.contextSource,
		description: summary.description,
		arn: summary.inferenceProfileArn,
		region: parsedArn.region,
		status: summary.status,
		isGlobal: targetId.startsWith("global."),
		isCrossRegion: targetKind === "system-profile" && !targetId.startsWith("global."),
		supportsImages: resolved.info.supportsImages,
		supportsPromptCache: resolved.info.supportsPromptCache,
	}
}

const listInferenceProfiles = async (client: BedrockClient) => {
	const results: InferenceProfileSummary[] = []
	let nextToken: string | undefined

	do {
		const response = await client.send(
			new ListInferenceProfilesCommand({
				nextToken,
				maxResults: 100,
			}),
		)

		results.push(...(response.inferenceProfileSummaries ?? []))
		nextToken = response.nextToken
	} while (nextToken)

	return results
}

export const discoverBedrockTargets = async (options: ProviderSettings): Promise<BedrockDiscoveredTarget[]> => {
	if (!options.awsRegion) {
		return []
	}

	const client = new BedrockClient(toBedrockClientConfig(options))

	const [foundationModelsResponse, inferenceProfiles] = await Promise.all([
		client.send(new ListFoundationModelsCommand({})),
		listInferenceProfiles(client),
	])

	const targets = [
		...(foundationModelsResponse.modelSummaries ?? [])
			.map((summary) => buildFoundationTarget(summary))
			.filter((target): target is BedrockDiscoveredTarget => Boolean(target)),
		...inferenceProfiles
			.filter((summary) => summary.status === "ACTIVE")
			.map((summary) => buildInferenceProfileTarget(summary))
			.filter((target): target is BedrockDiscoveredTarget => Boolean(target)),
	]

	const dedupedTargets = Array.from(new Map(targets.map((target) => [target.id, target])).values())

	const sortedTargets = dedupedTargets.sort((a, b) => {
		const kindOrder = { "foundation-model": 0, "system-profile": 1, "application-profile": 2 }
		const kindCompare = kindOrder[a.targetKind] - kindOrder[b.targetKind]
		if (kindCompare !== 0) {
			return kindCompare
		}

		if (a.baseModelId !== b.baseModelId) {
			return a.baseModelId.localeCompare(b.baseModelId)
		}

		return a.label.localeCompare(b.label)
	})

	// AWS often returns a single inference profile id for models that support both 128K
	// and 1M context windows. Expand those into two dropdown entries so users can pick
	// the context tier explicitly; the `:1m` suffix is round-tripped through the runtime.
	return expandBedrockTargetsWith1MVariants(sortedTargets)
}

/**
 * Upper bound for any single probe attempt. Larger than every published Anthropic max
 * output cap as of 2026; if AWS ever raises a model above this we'll discover that
 * via a future bump rather than racing the slider's UI bounds.
 */
export const BEDROCK_MAX_OUTPUT_PROBE_CEILING = 1_000_000

const MIN_PROBE_FLOOR = 8_192

/**
 * AWS phrases its "max_tokens too large" rejection in several ways. The regex below
 * extracts the model-side cap from the most common shapes:
 *   "max_tokens: 200000 > X"
 *   "max_tokens must be less than or equal to X"
 *   "maximum value: X"
 *   "the maximum number of tokens that can be generated for this model is X"
 */
const MAX_TOKENS_HINT_PATTERNS: RegExp[] = [
	/maxtokens\s*[:=]?\s*\d+[^\d]+(\d{3,7})/i,
	/maximum(?:[\s_-]?tokens?)?[^\d]{0,40}(\d{3,7})/i,
	/<=?\s*(\d{3,7})\s*(?:tokens?)?/,
	/less than or equal to\s*(\d{3,7})/i,
	/up to\s*(\d{3,7})\s*tokens?/i,
]

const extractMaxTokensFromError = (error: unknown): number | undefined => {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
	const aggregate = `${message} ${(error as any)?.$response?.body ?? ""}`
	let best: number | undefined
	for (const pattern of MAX_TOKENS_HINT_PATTERNS) {
		const match = aggregate.match(pattern)
		if (!match) continue
		const candidate = Number.parseInt(match[1], 10)
		if (!Number.isFinite(candidate)) continue
		if (candidate < MIN_PROBE_FLOOR || candidate > BEDROCK_MAX_OUTPUT_PROBE_CEILING) continue
		if (best === undefined || candidate < best) {
			best = candidate
		}
	}
	return best
}

const isMaxTokensValidationError = (error: unknown): boolean => {
	if (!error) return false
	const name = (error as any).name ?? ""
	const type = (error as any).__type ?? ""
	if (
		name !== "ValidationException" &&
		!String(name).toLowerCase().includes("validation") &&
		!String(type).toLowerCase().includes("validation")
	) {
		return false
	}
	const message = String((error as any).message ?? "").toLowerCase()
	return (
		message.includes("max_tokens") ||
		message.includes("maxtokens") ||
		message.includes("maximum tokens") ||
		message.includes("output tokens") ||
		message.includes("max output")
	)
}

export interface BedrockMaxOutputProbeResult {
	maxOutputTokens: number
	/**
	 * `"accepted"` when the probe ceiling went through verbatim; `"hint"` when AWS rejected
	 * a probe and we recovered the true cap from the error message; `"binary-search"` when
	 * we narrowed the cap with successive probes because no usable hint was returned.
	 */
	source: "accepted" | "hint" | "binary-search"
	attempts: number
}

export interface BedrockMaxOutputProbeOptions {
	options: ProviderSettings
	modelId: string
	probeCeiling?: number
	/**
	 * Optional injection point for tests (and the eventual webview message handler) so the
	 * helper does not need to construct a real AWS client. The function is invoked with the
	 * `maxTokens` value to attempt and must either resolve (success) or reject with the
	 * AWS `ValidationException` shape.
	 */
	runProbe?: (maxTokens: number) => Promise<unknown>
}

/**
 * Empirically determines the maximum `inferenceConfig.maxTokens` AWS Bedrock will
 * accept for a given model id. AWS does not expose this value in `GetFoundationModel`,
 * so we send a minimal Converse request with a 1-token user prompt and progressively
 * narrow the cap based on the responses.
 *
 * Strategy:
 *   1. Try the probe ceiling (defaults to {@link BEDROCK_MAX_OUTPUT_PROBE_CEILING}).
 *   2. If AWS accepts it, return that ceiling immediately.
 *   3. If AWS rejects it with a parsable hint (e.g. `"max_tokens must be <= 128000"`),
 *      verify the hinted value with one additional probe and return it on success.
 *   4. Otherwise fall back to binary search bounded by `[MIN_PROBE_FLOOR, ceiling]` until
 *      we find the largest accepted value.
 */
export const probeBedrockMaxOutputTokens = async ({
	options,
	modelId,
	probeCeiling = BEDROCK_MAX_OUTPUT_PROBE_CEILING,
	runProbe,
}: BedrockMaxOutputProbeOptions): Promise<BedrockMaxOutputProbeResult> => {
	if (!options.awsRegion) {
		throw new Error("AWS region is required to probe Bedrock max output tokens")
	}
	if (!modelId) {
		throw new Error("Model id is required to probe Bedrock max output tokens")
	}

	const client = runProbe ? undefined : new BedrockRuntimeClient(toBedrockRuntimeClientConfig(options))

	const attempt = async (maxTokens: number) => {
		if (runProbe) {
			await runProbe(maxTokens)
			return
		}
		const command = new ConverseCommand({
			modelId,
			messages: [
				{
					role: "user",
					content: [{ text: "Hi." }],
				},
			],
			inferenceConfig: { maxTokens },
		})
		await client!.send(command)
	}

	let attempts = 0

	// 1. Try the ceiling directly. If AWS accepts, we're done.
	try {
		attempts += 1
		await attempt(probeCeiling)
		return { maxOutputTokens: probeCeiling, source: "accepted", attempts }
	} catch (error) {
		if (!isMaxTokensValidationError(error)) {
			throw error
		}

		// 2. Try to extract the cap from AWS's error message and verify it.
		const hint = extractMaxTokensFromError(error)
		if (hint && hint < probeCeiling && hint >= MIN_PROBE_FLOOR) {
			try {
				attempts += 1
				await attempt(hint)
				return { maxOutputTokens: hint, source: "hint", attempts }
			} catch (innerError) {
				if (!isMaxTokensValidationError(innerError)) {
					throw innerError
				}
				// Fall through to binary search if even the hinted value was rejected.
			}
		}

		// 3. Binary search between [MIN_PROBE_FLOOR, probeCeiling - 1]. We've already proven
		//    `probeCeiling` fails, so the high bound starts strictly below it.
		let lo = MIN_PROBE_FLOOR
		let hi = probeCeiling - 1
		let bestAccepted: number | undefined
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2)
			attempts += 1
			try {
				await attempt(mid)
				bestAccepted = mid
				lo = mid + 1
			} catch (innerError) {
				if (!isMaxTokensValidationError(innerError)) {
					throw innerError
				}
				hi = mid - 1
			}
		}

		if (bestAccepted) {
			return { maxOutputTokens: bestAccepted, source: "binary-search", attempts }
		}

		throw new Error(
			`Bedrock rejected every probed max_tokens value (floor ${MIN_PROBE_FLOOR}, ceiling ${probeCeiling}). Original error: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}
