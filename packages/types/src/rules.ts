export type RuleScope = "global" | "project"

export type RuleKind = "generic" | "mode"

export interface RuleMetadata {
	id: string
	name: string
	scope: RuleScope
	kind: RuleKind
	modeSlug?: string
	modeName?: string
	filePath: string
	relativePath: string
	directoryPath: string
	description?: string
	isSymlink?: boolean
}

export interface CreateRuleInput {
	scope: RuleScope
	kind: RuleKind
	modeSlug?: string
	fileName: string
}

export interface DeleteRuleInput {
	id?: string
	scope: RuleScope
	kind: RuleKind
	modeSlug?: string
	relativePath: string
}

export type RuleLookupInput = DeleteRuleInput
