import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"

function collectWorkerImports(entryPath: string) {
	const visited = new Set<string>()
	const imports: string[] = []
	const pending = [entryPath]
	while (pending.length > 0) {
		const filePath = pending.pop()!
		if (visited.has(filePath)) continue
		visited.add(filePath)
		const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true)
		function visit(node: ts.Node): void {
			let modulePath: string | undefined
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
				if (ts.isStringLiteral(node.moduleSpecifier)) modulePath = node.moduleSpecifier.text
			} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
				if (ts.isStringLiteral(node.argument.literal)) modulePath = node.argument.literal.text
			} else if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require"))
			) {
				const argument = node.arguments[0]
				if (argument && ts.isStringLiteral(argument)) modulePath = argument.text
			}
			if (ts.isIdentifier(node)) expect(node.text).not.toBe("createRequire")
			if (modulePath !== undefined) {
				imports.push(modulePath)
				if (modulePath.startsWith(".")) {
					const resolved = path.resolve(path.dirname(filePath), modulePath)
					const dependency = [resolved, `${resolved}.ts`, path.join(resolved, "index.ts")].find(
						(candidate) => candidate.endsWith(".ts") && existsSync(candidate),
					)
					expect(dependency, `${filePath}: ${modulePath}`).toBeDefined()
					if (dependency) pending.push(dependency)
				}
			}
			ts.forEachChild(node, visit)
		}
		visit(source)
	}
	return { visited, imports }
}

it("keeps host imports out of the entire worker source graph, including type-only and dynamic imports", () => {
	const { visited, imports } = collectWorkerImports(path.resolve("workers/codeIndexParse.ts"))
	expect(imports.filter((modulePath) => /^(?:vscode(?:\/|$)|@roo-code\/)/.test(modulePath))).toEqual([])
	const files = [...visited].map((filePath) => filePath.replaceAll("\\", "/"))
	expect(files.some((filePath) => filePath.endsWith("/code-index-log.ts"))).toBe(true)
	expect(files.some((filePath) => filePath.endsWith("/parse-worker-protocol.ts"))).toBe(true)
	expect(
		files.filter((filePath) => /\/(?:code-index-log-host|parse-worker-client|manager)\.ts$/.test(filePath)),
	).toEqual([])
})
