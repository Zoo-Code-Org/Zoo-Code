import { resolveBedrockCustomArnBaseModelId } from "../providers/bedrock.js"

const appProfileArn = "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abcd1234efgh"

describe("resolveBedrockCustomArnBaseModelId", () => {
	it("returns the explicit base model when it is a known Bedrock model", () => {
		expect(resolveBedrockCustomArnBaseModelId(appProfileArn, "anthropic.claude-opus-5-5")).toBe(
			"anthropic.claude-opus-5-5",
		)
	})

	it("prefers the explicit base model over one named in the ARN", () => {
		const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8"
		expect(resolveBedrockCustomArnBaseModelId(arn, "meta.llama3-3-70b-instruct-v1:0")).toBe(
			"meta.llama3-3-70b-instruct-v1:0",
		)
	})

	it("detects a model named at the end of the ARN", () => {
		expect(
			resolveBedrockCustomArnBaseModelId(
				"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
				undefined,
			),
		).toBe("anthropic.claude-opus-4-8")
		expect(
			resolveBedrockCustomArnBaseModelId(
				"arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
				"",
			),
		).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0")
	})

	it("falls back to the model named in the ARN when the saved base model is unknown", () => {
		expect(
			resolveBedrockCustomArnBaseModelId(
				"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
				"anthropic.claude-retired-model",
			),
		).toBe("anthropic.claude-opus-4-8")
	})

	it("returns undefined when neither the setting nor the ARN identifies a model", () => {
		expect(resolveBedrockCustomArnBaseModelId(appProfileArn, undefined)).toBeUndefined()
		expect(resolveBedrockCustomArnBaseModelId(appProfileArn, "")).toBeUndefined()
		expect(resolveBedrockCustomArnBaseModelId(appProfileArn, "not-a-bedrock-model")).toBeUndefined()
		expect(resolveBedrockCustomArnBaseModelId(undefined, undefined)).toBeUndefined()
	})

	it("does not confuse models whose IDs share a suffix", () => {
		expect(
			resolveBedrockCustomArnBaseModelId(
				"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-2-lite-v1:0",
				undefined,
			),
		).toBe("amazon.nova-2-lite-v1:0")
	})
})
