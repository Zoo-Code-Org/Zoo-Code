const typescriptExpressionWrappers = new Set([
	"ChainExpression",
	"TSAsExpression",
	"TSInstantiationExpression",
	"TSNonNullExpression",
	"TSSatisfiesExpression",
	"TSTypeAssertion",
])

const useCanonicalMessageId = "useCanonical"

function unwrapExpression(node) {
	while (typescriptExpressionWrappers.has(node?.type)) {
		node = node.expression
	}

	return node
}

function getMemberExpressionStaticName(node) {
	if (!node.computed && node.property.type === "Identifier") {
		return node.property.name
	}

	if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
		return node.property.value
	}

	return undefined
}

function getStaticName(node) {
	node = unwrapExpression(node)

	switch (node?.type) {
		case "Identifier":
		case "PrivateIdentifier":
			return node.name
		case "MemberExpression":
			return getMemberExpressionStaticName(node)
		case "Literal":
			return typeof node.value === "string" ? node.value : undefined
		default:
			return undefined
	}
}

function isProviderLike(node) {
	return getStaticName(node)?.toLowerCase().includes("provider") ?? false
}

function isCanonicalProviderRegistry(node) {
	const name = getStaticName(node)
	return name === "providerIdentifiers" || name === "retiredProviderIdentifiers"
}

export function createProviderIdentifierConfig({ providerIdentifiers, retiredProviderIdentifiers }) {
	const providerReplacementsByValue = new Map([
		...Object.entries(providerIdentifiers).map(([member, value]) => [value, `providerIdentifiers.${member}`]),
		...Object.entries(retiredProviderIdentifiers).map(([member, value]) => [
			value,
			`retiredProviderIdentifiers.${member}`,
		]),
	])

	function getRawProvider(node) {
		node = unwrapExpression(node)

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

	function getProviderExpressionChildren(node) {
		node = unwrapExpression(node)

		if (node?.type === "LogicalExpression") {
			return [node.left, node.right]
		}

		if (node?.type === "ConditionalExpression") {
			return [node.consequent, node.alternate]
		}

		if (node?.type === "AssignmentPattern") {
			return [node.right]
		}

		if (node?.type === "CallExpression") {
			return node.arguments
		}

		if (node?.type === "ArrayExpression") {
			return node.elements.filter((element) => element !== null)
		}

		return []
	}

	function getProviderMapDeclarator(objectExpression) {
		let expression = objectExpression
		while (typescriptExpressionWrappers.has(expression.parent?.type)) {
			expression = expression.parent
		}

		const declarator = expression.parent
		return declarator?.type === "VariableDeclarator" && declarator.init === expression ? declarator : undefined
	}

	const noRawProviderIdentifiers = {
		meta: {
			type: "problem",
			docs: { description: "Require canonical provider identifiers in provider-like contexts" },
			schema: [],
			messages: {
				[useCanonicalMessageId]: 'Use {{replacement}} instead of the raw provider identifier "{{value}}".',
			},
		},
		create(context) {
			function reportIfRawProvider(node) {
				for (const child of getProviderExpressionChildren(node)) {
					reportIfRawProvider(child)
				}

				const provider = getRawProvider(node)
				if (provider) {
					context.report({ node, messageId: useCanonicalMessageId, data: provider })
				}
			}

			function reportIfRawProviderMapKey(node) {
				if (node.parent?.type !== "ObjectExpression") {
					return
				}

				const declarator = getProviderMapDeclarator(node.parent)
				if (!declarator || !isProviderLike(declarator.id) || isCanonicalProviderRegistry(declarator.id)) {
					return
				}

				const rawProvider = getRawProvider(node.key)
				if (node.computed && !rawProvider) {
					return
				}

				const value = rawProvider?.value ?? getStaticName(node.key)
				const replacement = value ? providerReplacementsByValue.get(value) : undefined
				if (replacement) {
					context.report({
						node: node.key,
						messageId: useCanonicalMessageId,
						data: { replacement, value },
					})
				}
			}

			return {
				Property(node) {
					reportIfRawProviderMapKey(node)
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
				AssignmentPattern(node) {
					if (node.parent?.type === "Property" && isProviderLike(node.parent.key)) {
						return
					}

					if (isProviderLike(node.left)) {
						reportIfRawProvider(node.right)
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
				CallExpression(node) {
					if (isProviderLike(node.callee)) {
						for (const argument of node.arguments) {
							reportIfRawProvider(argument)
						}
					}
				},
			}
		},
	}

	return {
		files: ["**/*.ts", "**/*.tsx"],
		ignores: ["**/fixtures/**"],
		plugins: {
			zoo: {
				rules: {
					"no-raw-provider-identifiers": noRawProviderIdentifiers,
				},
			},
		},
		rules: {
			"zoo/no-raw-provider-identifiers": "error",
		},
	}
}
