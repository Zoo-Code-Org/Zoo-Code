import { ReviewPromptFactory } from "../ReviewPromptFactory"

describe("ReviewPromptFactory", () => {
	it("creates rubric-driven memory and skill prompts", () => {
		const factory = new ReviewPromptFactory()

		const memoryPrompt = factory.createMemoryReviewPrompt("Conversation summary")
		const skillPrompt = factory.createSkillReviewPrompt("Conversation summary")

		expect(memoryPrompt.type).toBe("memory")
		expect(memoryPrompt.systemPrompt).toContain("FACT:")
		expect(memoryPrompt.userPrompt).toContain("Conversation summary")
		expect(skillPrompt.type).toBe("skill")
		expect(skillPrompt.systemPrompt).toContain("ACTION:")
		expect(skillPrompt.systemPrompt).toContain("Priority Order")
	})

	it("creates a combined prompt with memory and skill output sections", () => {
		const factory = new ReviewPromptFactory()
		const prompt = factory.createCombinedReviewPrompt("Combined summary")

		expect(prompt.type).toBe("combined")
		expect(prompt.systemPrompt).toContain("MEMORY_FACT:")
		expect(prompt.systemPrompt).toContain("SKILL_ACTION:")
		expect(prompt.userPrompt).toContain("Combined summary")
	})
})
