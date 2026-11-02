/**
 * Finds t("ns:key", { ... }) calls that do not pass a variable the English string needs.
 * Example: the string has {{exitCode}} but the call passes { exitStatus }.
 *
 * Usage: node scripts/check-i18n-interpolation.js
 *
 * Only calls with a string-literal key and an object-literal second argument are checked.
 * A spread in the object skips the call.
 */

const path = require("path")
const fs = require("fs")
const { execFileSync } = require("child_process")
const ts = require("typescript")

const ROOT = path.join(__dirname, "..")
const PACKAGES = ["src", "webview-ui/src"]

const files = execFileSync(
	"git",
	["ls-files", "-z", "--", ...PACKAGES.map((p) => `${p}/**/*.ts`), ...PACKAGES.map((p) => `${p}/**/*.tsx`)],
	{
		cwd: ROOT,
		encoding: "utf8",
	},
)
	.split("\0")
	.filter((f) => f && !/(\/__tests__\/|\.(spec|test)\.tsx?$)/.test(f))

const resources = {}
function getResource(pkg, ns) {
	// A namespace is a locale file name. Reject anything that could leave the locale directory.
	if (!/^[\w.-]+$/.test(ns)) return undefined
	const id = `${pkg}:${ns}`
	if (!(id in resources)) {
		const file = path.join(ROOT, pkg === "src" ? "src" : "webview-ui/src", "i18n/locales/en", `${ns}.json`)
		resources[id] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined
	}
	return resources[id]
}

function lookup(resource, keyPath) {
	let node = resource
	for (const part of keyPath.split(".")) {
		if (node === null || typeof node !== "object" || !(part in node)) return undefined
		node = node[part]
	}
	return node
}

// "Exited with {{exitCode}}" and "{{- name}}" and "{{n, number}}" -> exitCode, name, n
function placeholders(value) {
	return [...value.matchAll(/\{\{-?\s*([\w$]+)[^}]*\}\}/g)].map((m) => m[1])
}

const problems = []

for (const rel of files) {
	const pkg = rel.startsWith("src/") ? "src" : "webview-ui"
	const source = fs.readFileSync(path.join(ROOT, rel), "utf8")
	const sf = ts.createSourceFile(
		rel,
		source,
		ts.ScriptTarget.Latest,
		true,
		rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	)

	const visit = (node) => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression
			const isT =
				(ts.isIdentifier(callee) && callee.text === "t") ||
				(ts.isPropertyAccessExpression(callee) && callee.name.text === "t")
			const [keyArg, optionsArg] = node.arguments
			if (
				isT &&
				keyArg &&
				ts.isStringLiteralLike(keyArg) &&
				keyArg.text.includes(":") &&
				optionsArg &&
				ts.isObjectLiteralExpression(optionsArg) &&
				!optionsArg.properties.some(ts.isSpreadAssignment)
			) {
				// i18next splits on the first ":" and joins the rest with "."
				const [ns, ...rest] = keyArg.text.split(":")
				const keyPath = rest.join(".")
				const resource = getResource(pkg, ns)
				if (resource) {
					const passed = new Set(
						optionsArg.properties.map(
							(p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text,
						),
					)
					// A plural key lives under key_one, key_other, and so on.
					const values = [keyPath, `${keyPath}_zero`, `${keyPath}_one`, `${keyPath}_other`]
						.map((k) => lookup(resource, k))
						.filter((v) => typeof v === "string")
					const missing = new Set(values.flatMap(placeholders).filter((name) => !passed.has(name)))
					if (missing.size > 0) {
						const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
						problems.push(
							`${rel}:${line + 1}  t("${keyArg.text}") does not pass: ${[...missing].join(", ")}`,
						)
					}
				}
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
}

if (problems.length > 0) {
	console.error(`Found ${problems.length} t() call(s) missing an interpolation variable:\n${problems.join("\n")}`)
	process.exit(1)
}
console.log(`OK: checked ${files.length} files, no missing interpolation variables.`)
