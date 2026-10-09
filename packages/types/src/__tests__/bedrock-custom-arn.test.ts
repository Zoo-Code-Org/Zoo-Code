import {
	BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL,
	isBedrockFoundationModelArn,
	resolveBedrockCustomArnBaseModelId,
} from "../providers/bedrock.js"

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

	it("lets an explicit Other choice override a model named in the ARN", () => {
		expect(
			resolveBedrockCustomArnBaseModelId(
				"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
				BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL,
			),
		).toBeUndefined()
	})

	it("always resolves a foundation-model ARN to the model it names", () => {
		const foundationArn = "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0"

		expect(resolveBedrockCustomArnBaseModelId(foundationArn, "anthropic.claude-opus-5-5")).toBe(
			"anthropic.claude-3-5-sonnet-20241022-v2:0",
		)
		expect(resolveBedrockCustomArnBaseModelId(foundationArn, BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL)).toBe(
			"anthropic.claude-3-5-sonnet-20241022-v2:0",
		)
		expect(
			resolveBedrockCustomArnBaseModelId(
				"arn:aws:bedrock:us-east-1::foundation-model/vendor.unlisted-model-v1:0",
				"anthropic.claude-opus-5-5",
			),
		).toBeUndefined()
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

describe("isBedrockFoundationModelArn", () => {
	it("recognizes foundation-model ARNs in any partition", () => {
		expect(isBedrockFoundationModelArn("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2")).toBe(
			true,
		)
		expect(
			isBedrockFoundationModelArn("arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/anthropic.claude-v2"),
		).toBe(true)
	})

	it("rejects other ARN types and missing values", () => {
		expect(isBedrockFoundationModelArn(appProfileArn)).toBe(false)
		expect(
			isBedrockFoundationModelArn(
				"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
			),
		).toBe(false)
		expect(isBedrockFoundationModelArn(undefined)).toBe(false)
		expect(isBedrockFoundationModelArn("")).toBe(false)
	})
})
