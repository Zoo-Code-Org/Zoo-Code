/**
 * Review type
 */
export type ReviewType = "memory" | "skill" | "combined"

/**
 * Review prompt result
 */
export interface ReviewPrompt {
	type: ReviewType
	systemPrompt: string
	userPrompt: string
}

/**
 * ReviewPromptFactory — generates structured review prompts.
 */
export class ReviewPromptFactory {
	createMemoryReviewPrompt(transcriptSummary: string): ReviewPrompt {
		return {
			type: "memory",
			systemPrompt: `You are a memory review specialist. Your task is to review the recent conversation transcript and identify durable facts that should be saved to long-term memory.

## Guidelines
- Save facts that are likely to be useful across multiple sessions
- Save user preferences, project conventions, and environment details
- Do NOT save transient information (one-off commands, temporary errors)
- Do NOT save information that is already in memory
- Prefer concise, actionable facts over verbose descriptions
- Each fact should be a single, clear statement

## Output Format
For each fact you want to save, output:
FACT: <the fact to save>
CATEGORY: <environment | user-profile>
REASON: <why this fact is durable and useful>`,
			userPrompt: `Review the following conversation transcript and identify durable facts to save to memory.

${transcriptSummary}

Output your recommendations following the specified format.`,
		}
	}

	createSkillReviewPrompt(transcriptSummary: string): ReviewPrompt {
		return {
			type: "skill",
			systemPrompt: `You are a skill review specialist. Your task is to review the recent conversation transcript and identify reusable procedures that should be saved as skills.

## Guidelines
- Create skills for procedures that are repeated or likely to be repeated
- Update existing skills if the transcript reveals improvements
- Prefer class-level skills over one-off task narratives
- Avoid creating skills for transient environment failures
- Each skill should have a clear, single responsibility
- Support files (scripts, templates) should be separate from the main skill definition

## Priority Order
1. Update an existing loaded skill if the transcript reveals improvements
2. Create an umbrella skill that groups related procedures
3. Add a support file (script, template) to an existing skill
4. Create a new standalone skill

## Output Format
For each skill action, output:
ACTION: <create | update | add-support-file>
SKILL_NAME: <name of the skill>
DESCRIPTION: <brief description>
CONTENT: <the skill content or update>
REASON: <why this skill is valuable>`,
			userPrompt: `Review the following conversation transcript and identify reusable procedures to save as skills.

${transcriptSummary}

Output your recommendations following the specified format.`,
		}
	}

	createCombinedReviewPrompt(transcriptSummary: string): ReviewPrompt {
		return {
			type: "combined",
			systemPrompt: `You are a self-improvement review specialist. Your task is to review the recent conversation transcript and identify both durable facts (memory) and reusable procedures (skills).

## Memory Guidelines
- Memory is for facts: user preferences, project conventions, environment details
- Save facts that are durable and useful across sessions
- Each fact should be concise and actionable

## Skill Guidelines
- Skills are for procedures: repeatable workflows, command sequences, code patterns
- Create skills for procedures likely to be repeated
- Update existing skills with improvements from the transcript
- Prefer class-level skills over one-off narratives

## Output Format
For memory facts:
MEMORY_FACT: <the fact>
MEMORY_CATEGORY: <environment | user-profile>

For skill actions:
SKILL_ACTION: <create | update>
SKILL_NAME: <name>
SKILL_CONTENT: <content or update>`,
			userPrompt: `Review the following conversation transcript and identify both durable facts (memory) and reusable procedures (skills).

${transcriptSummary}

Output your recommendations following the specified format.`,
		}
	}
}
