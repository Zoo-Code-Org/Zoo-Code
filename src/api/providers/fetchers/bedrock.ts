import { BedrockClient, ListFoundationModelsCommand, paginateListInferenceProfiles } from "@aws-sdk/client-bedrock"
import { fromIni } from "@aws-sdk/credential-providers"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import { HttpsProxyAgent } from "https-proxy-agent"
import { HttpProxyAgent } from "http-proxy-agent"
import type { BedrockCatalogEntry, ProviderSettings } from "@roo-code/types"
import { getSystemProxyUrl } from "../../../utils/networkProxy"

/** Query the regional control plane, not a custom inference/runtime endpoint. */
export async function getBedrockCatalog(options: ProviderSettings): Promise<BedrockCatalogEntry[]> {
	if (!options.awsRegion) throw new Error("Select an AWS region before refreshing the catalogue.")
	if (options.awsUseApiKey)
		throw new Error("Catalogue discovery requires AWS IAM credentials or an AWS profile, not a Bedrock API key.")
	const proxy = getSystemProxyUrl()
	const client = new BedrockClient({
		region: options.awsRegion,
		maxAttempts: 2,
		credentials:
			options.awsUseProfile && options.awsProfile
				? fromIni({ profile: options.awsProfile, ignoreCache: true })
				: options.awsAccessKey && options.awsSecretKey
					? {
							accessKeyId: options.awsAccessKey,
							secretAccessKey: options.awsSecretKey,
							sessionToken: options.awsSessionToken,
						}
					: undefined,
		requestHandler: new NodeHttpHandler({
			requestTimeout: 30_000,
			...(proxy ? { httpAgent: new HttpProxyAgent(proxy), httpsAgent: new HttpsProxyAgent(proxy) } : {}),
		}),
	})
	const signal = AbortSignal.timeout(30_000)
	try {
		const result: BedrockCatalogEntry[] = []
		const foundations = await client.send(
			new ListFoundationModelsCommand({ byOutputModality: "TEXT", byInferenceType: "ON_DEMAND" }),
			{ abortSignal: signal },
		)
		for (const model of foundations.modelSummaries ?? []) {
			if (model.modelArn && model.responseStreamingSupported && model.modelLifecycle?.status !== "LEGACY") {
				result.push({
					arn: model.modelArn,
					name: model.modelName ?? model.modelId ?? model.modelArn,
					kind: "regional",
				})
			}
		}
		for await (const page of paginateListInferenceProfiles({ client }, {}, { abortSignal: signal })) {
			for (const profile of page.inferenceProfileSummaries ?? []) {
				if (!profile.inferenceProfileArn || profile.status !== "ACTIVE") continue
				result.push({
					arn: profile.inferenceProfileArn,
					name: profile.inferenceProfileName ?? profile.inferenceProfileId ?? profile.inferenceProfileArn,
					kind:
						profile.type === "APPLICATION"
							? "application"
							: profile.inferenceProfileId?.startsWith("global.")
								? "global"
								: "geographic",
				})
			}
		}
		return result.sort((a, b) => a.name.localeCompare(b.name))
	} finally {
		client.destroy()
	}
}
