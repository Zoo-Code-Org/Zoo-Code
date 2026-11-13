// Guards that keep translated output in step with a language switch. Built-in no-restricted-syntax only.
// Translations must come from the component's `t` (webview-ui's `useAppTranslation`), which changes identity
// on a language switch; the global instance's `t` gives React (and React Compiler caches) nothing to
// invalidate on, so memoized output would keep the previous language.

// Selectors cannot follow bindings, so the instance is recognised by name: a default import or
// `useTranslation().i18n` held as `i18n`/`i18next`. The aliasing selectors below keep it under those names.
// Passing the instance as an argument and reading `.t` from the parameter is not caught.
const i18nInstanceName = "/^(i18n|i18next)$/"
const i18nInstance = `:matches([name=${i18nInstanceName}], MemberExpression[property.name=${i18nInstanceName}])`

// i18next itself and modules that re-export its instance as their default (webview-ui's i18n/setup).
const i18nInstanceSource = "/^(i18next|(.*\\/)?i18n\\/setup|\\.\\.?\\/setup)$/"

const globalTMessage = "Use t from useAppTranslation so memoized output follows language changes."
const aliasMessage =
	"Keep the i18next instance named i18n or i18next: the global-t check recognises it by name, so an alias hides i18n.t."

export const i18nLanguageSwitchSelectors = [
	{
		// Global t read off the instance: i18next.t(...), i18n?.t(...), i18next["t"], useTranslation().i18n.t.
		selector: `MemberExpression:matches([property.name='t'][computed=false], [property.value='t']):has(> ${i18nInstance}.object)`,
		message: globalTMessage,
	},
	{
		// Global t destructured from the instance: const { t } = i18next, const { t: translate } = i18n.
		// Other properties stay allowed: const { language } = i18next.
		selector: `VariableDeclarator:has(> ${i18nInstance}.init) > ObjectPattern > Property[key.name='t']`,
		message: globalTMessage,
	},
	{
		// Default import under another name: import lang from "i18next", import { default as lang } from "@/i18n/setup".
		// Named imports such as initReactI18next or `type TFunction` are other specifiers and are not matched.
		selector: `ImportDeclaration[source.value=${i18nInstanceSource}] > :matches(ImportDefaultSpecifier, ImportSpecifier[imported.name='default']):not([local.name=${i18nInstanceName}])`,
		message: aliasMessage,
	},
	{
		// Namespace import: import * as lang from "i18next" exposes the instance's t as lang.t whatever lang is called.
		selector: `ImportDeclaration[source.value=${i18nInstanceSource}] > ImportNamespaceSpecifier`,
		message: aliasMessage,
	},
	{
		// Re-export under another name: export { default as lang } from "i18next" lets importers alias it unseen.
		selector: `ExportNamedDeclaration[source.value=${i18nInstanceSource}] > ExportSpecifier[local.name='default']:not([exported.name=${i18nInstanceName}])`,
		message: aliasMessage,
	},
	{
		// Variable alias: const lang = i18next, const lang = useTranslation().i18n.
		// Keeping the name is fine (const i18n = useTranslation().i18n); calls such as i18next.createInstance() are not
		// the instance itself and are not matched.
		selector: `VariableDeclarator[id.type='Identifier']:not([id.name=${i18nInstanceName}]):has(> ${i18nInstance}.init)`,
		message: aliasMessage,
	},
	{
		// Assignment alias to an existing variable: lang = i18n.
		selector: `AssignmentExpression:not([left.name=${i18nInstanceName}]):has(> ${i18nInstance}.right)`,
		message: aliasMessage,
	},
	{
		// Destructuring rename, in declarations and parameters: const { i18n: lang } = useTranslation(),
		// ({ i18n: lang }) => ..., and a nested pattern such as const { i18n: { t } } = useTranslation().
		// The shorthand const { i18n } = useTranslation() keeps the name and is allowed.
		selector: `ObjectPattern > Property[key.name=${i18nInstanceName}]:not([value.name=${i18nInstanceName}])`,
		message: aliasMessage,
	},
	{
		// <Trans> without its own t={t}: it reads the global instance, so a memoized element keeps the old language.
		// Direct child only: <Trans components={{ b: <Foo t={1} /> }} /> is allowed.
		selector: "JSXOpeningElement[name.name='Trans']:not(:has(> JSXAttribute[name.name='t']))",
		message:
			"Pass t={t} from useAppTranslation: Trans does not subscribe to language changes, so a cached <Trans> keeps the previous language.",
	},
]
