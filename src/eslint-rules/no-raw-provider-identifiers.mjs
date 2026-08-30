import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

const providerReplacementsByValue = new Map([
	...Object.entries(providerIdentifiers).map(([member, value]) => [value, `providerIdentifiers.${member}`]),
	...Object.entries(retiredProviderIdentifiers).map(([member, value]) => [
		value,
		`retiredProviderIdentifiers.${member}`,
	]),
])
const typescriptExpressionWrappers = new Set([
	"TSAsExpression",
	"TSNonNullExpression",
	"TSSatisfiesExpression",
	"TSTypeAssertion",
])

function getStaticName(node) {
	if (node?.type === "Identifier") {
		return node.name
	}

	if (node?.type === "MemberExpression") {
		if (!node.computed && node.property.type === "Identifier") {
			return node.property.name
		}

		if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
			return node.property.value
		}
	}

	if (node?.type === "Literal" && typeof node.value === "string") {
		return node.value
	}

	return undefined
}

function isProviderLike(node) {
	return getStaticName(node)?.toLowerCase().includes("provider") ?? false
}

function getRawProvider(node) {
	while (typescriptExpressionWrappers.has(node?.type)) {
		node = node.expression
	}

	if (node?.type === "Literal" && typeof node.value === "string") {
		const replacement = providerReplacementsByValue.get(node.value)
		return replacement ? { replacement, value: node.value } : undefined
	}

	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
		const value = node.quasis[0]?.value.cooked
		const replacement = value ? providerReplacementsByValue.get(value) : undefined
		return replacement ? { replacement, value } : undefined
	}

	return undefined
}

export const noRawProviderIdentifiers = {
	meta: {
		type: "problem",
		docs: { description: "Require canonical provider identifiers in provider-like contexts" },
		schema: [],
		messages: {
			useCanonical:
				'Use {{replacement}} instead of the raw provider identifier "{{value}}".',
		},
	},
	create(context) {
		function reportIfRawProvider(node) {
			const provider = getRawProvider(node)
			if (provider) {
				context.report({ node, messageId: "useCanonical", data: provider })
			}
		}

		return {
			Property(node) {
				if (isProviderLike(node.key)) {
					reportIfRawProvider(node.value)
				}
			},
			PropertyDefinition(node) {
				if (isProviderLike(node.key)) {
					reportIfRawProvider(node.value)
				}
			},
			VariableDeclarator(node) {
				if (isProviderLike(node.id)) {
					reportIfRawProvider(node.init)
				}
			},
			AssignmentExpression(node) {
				if (isProviderLike(node.left)) {
					reportIfRawProvider(node.right)
				}
			},
			BinaryExpression(node) {
				if (!["===", "!==", "==", "!="].includes(node.operator)) {
					return
				}

				if (isProviderLike(node.left)) {
					reportIfRawProvider(node.right)
				}
				if (isProviderLike(node.right)) {
					reportIfRawProvider(node.left)
				}
			},
			SwitchStatement(node) {
				if (isProviderLike(node.discriminant)) {
					for (const switchCase of node.cases) {
						reportIfRawProvider(switchCase.test)
					}
				}
			},
		}
	},
}
