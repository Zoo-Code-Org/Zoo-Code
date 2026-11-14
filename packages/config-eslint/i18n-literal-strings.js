// Flags user-facing text written as literals in JSX, so labels go through translation keys instead.
// JSX text is checked by eslint-plugin-i18next's no-literal-string. Its jsx-text-only mode never looks at
// attributes or at expressions in element children, so the selectors below cover literals rendered from
// the attributes people see or hear and from children such as {t("x") || "Fallback"}.
import pluginI18next from "eslint-plugin-i18next"

const message =
	"Translate user-facing text: use a key via t from useAppTranslation instead of a literal. For a brand name, URL or unit that must stay as is, add an eslint-disable-next-line comment with the reason."

// Attributes rendered as visible or announced text on any element. Everything else (className, href,
// data-*, ...) is skipped. ariaLabel is the prop that ToggleSwitch and Slider forward to aria-label.
export const userFacingAttributes = [
	"alt",
	"aria-description",
	"aria-label",
	"aria-placeholder",
	"aria-roledescription",
	"aria-valuetext",
	"ariaLabel",
	"label",
	"placeholder",
	"title",
]

// Props that render text only on specific components; on other elements the same name holds data.
export const userFacingComponentProps = {
	StandardTooltip: ["content"],
}

// Technical values that read the same in every language: URLs, AWS ARNs, host names, paths and JSON.
export const technicalLiteralPatterns = [
	/^(•\s*)?https?:\/\/\S*$/,
	/^arn:aws:\S+$/,
	/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/,
	/^[\w.~-]*(\/[\w.~-]+)+\/?$/,
	/^\{[\s\S]*\}$/,
]

// esquery regexes end at the first "/", so slashes are written as \x2F.
const toSelectorRegex = (pattern) => `/${pattern.source.replaceAll("\\/", "\\x2F").replaceAll("/", "\\x2F")}/`

const anyOf = (names) => `/^(${names.join("|")})$/`
const componentAttributes = Object.entries(userFacingComponentProps).map(
	([component, props]) => `JSXOpeningElement[name.name="${component}"] > JSXAttribute[name.name=${anyOf(props)}]`,
)
const attribute = `:matches(JSXAttribute[name.name=${anyOf(userFacingAttributes)}], ${componentAttributes.join(", ")})`
// Element children, except <style> (CSS) and <Trans> (fallback text the translation replaces).
const children = `:matches(JSXElement:not([openingElement.name.name=/^(style|Trans)$/]), JSXFragment)`
// A word of two or more letters; punctuation, numbers and symbols such as "•", "✓" or "%" stay allowed.
const wordy = "/[A-Za-z]{2,}/"
const notTechnical = technicalLiteralPatterns.map((pattern) => `:not([value=${toSelectorRegex(pattern)}])`).join("")
// The attribute's value itself or a branch of a ternary / logical fallback, never a call argument such as a
// t() key or a comparison operand: those are not what the attribute renders.
const valueBranch = ":matches(ConditionalExpression, LogicalExpression)"
const valuePositions = [
	`${attribute} > Literal`,
	...[attribute, children].flatMap((owner) => [
		`${owner} > JSXExpressionContainer > Literal`,
		`${owner} > JSXExpressionContainer > ${valueBranch} > Literal`,
		`${owner} > JSXExpressionContainer > ${valueBranch} > ${valueBranch} > Literal`,
	]),
]
const templatePositions = [attribute, children].flatMap((owner) => [
	`${owner} > JSXExpressionContainer > TemplateLiteral > TemplateElement`,
	`${owner} > JSXExpressionContainer > ${valueBranch} > TemplateLiteral > TemplateElement`,
])

export const i18nLiteralSelectors = [
	{
		// <img alt="Logo" />, title={ok ? "Saved" : t("x")}, label={name || "Unknown"}, <p>{t("x") || "Fallback"}</p>
		selector: valuePositions.map((position) => `${position}[value=${wordy}]${notTechnical}`).join(", "),
		message,
	},
	{
		// aria-label={`Open ${path}`}, <p>{`${count} hidden lines`}</p>: the template's static text is untranslated.
		selector: templatePositions.map((position) => `${position}[value.raw=${wordy}]`).join(", "),
		message,
	},
]

// The plugin's counterpart of `wordy`: text with at most one letter in a row ("⚠️", "(v", "→").
const noWord = /^(?:\p{L}(?!\p{L})|[^\p{L}])*$/u

/**
 * The JSX-text half: eslint-plugin-i18next's no-literal-string in jsx-text-only mode.
 * Add `i18nLiteralSelectors` to the same files' no-restricted-syntax list for attributes and children.
 *
 * @param {{ files: string[], ignores?: string[] }} options
 * @returns {import("eslint").Linter.Config}
 */
export function createI18nLiteralStringConfig({ files, ignores = [] }) {
	return {
		files,
		ignores,
		plugins: { i18next: pluginI18next },
		rules: {
			// Text inside <Trans> is the fallback the translation replaces, so the plugin skips it by default.
			"i18next/no-literal-string": [
				"error",
				{
					mode: "jsx-text-only",
					// Replaces the plugin's defaults: the same word test as the selectors, HTML entities, technical values.
					words: { exclude: [noWord, "(&#?[a-zA-Z0-9]+;|\\s)+", ...technicalLiteralPatterns] },
					message,
				},
			],
		},
	}
}
