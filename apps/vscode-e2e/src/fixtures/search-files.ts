import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./fixture-utils"

type SearchFilesFixture = {
	userMessagePattern: string
	toolName: string
	arguments: string
	toolCallId: string
	expected: string[]
	result: string
	id: string
}

export function addSearchFilesResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: SearchFilesFixture[] = [
		{
			userMessagePattern: "JavaScript function declarations",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"function\\\\s+\\\\w+"}',
			toolCallId: "call_search_files_functions_001",
			expected: [
				"# search-files-tool-fixture/search-fixture.js",
				"function calculateTotal(items) {",
				"function validateUser(user) {",
			],
			result: "The function search found declarations including `calculateTotal`, `validateUser`, and `formatCurrency`.",
			id: "call_search_files_functions_002",
		},
		{
			userMessagePattern: "TODO comments using the regex TODO",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"TODO.*"}',
			toolCallId: "call_search_files_todo_001",
			expected: [
				"# search-files-tool-fixture/search-fixture.js",
				"// TODO: Add more validation functions",
				"// TODO: Implement user fetching",
			],
			result: "The TODO search found matching TODO entries in the fixture files, including the validation and user-fetching notes.",
			id: "call_search_files_todo_002",
		},
		{
			userMessagePattern: "TypeScript interfaces you find",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"interface\\\\s+\\\\w+","file_pattern":"*.ts"}',
			toolCallId: "call_search_files_typescript_001",
			expected: ["# search-files-tool-fixture/search-fixture.ts", "interface User {", "interface Product {"],
			result: "The TypeScript-only search found the `User` and `Product` interface definitions.",
			id: "call_search_files_typescript_002",
		},
		{
			userMessagePattern: "JSON configuration keys",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"\\"\\\\w+\\":\\\\s*","file_pattern":"*.json"}',
			toolCallId: "call_search_files_json_001",
			expected: ["# search-files-tool-fixture/search-config.json", '"name": "test-app",', '"dependencies": {'],
			result: "The JSON search found configuration keys such as `name`, `version`, and `dependencies` in `search-config.json`.",
			id: "call_search_files_json_002",
		},
		{
			userMessagePattern: "formatCurrency and debounce",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"function\\\\s+(format|debounce)"}',
			toolCallId: "call_search_files_nested_001",
			expected: [
				"# search-files-tool-fixture/nested/nested-search.js",
				"function formatCurrency(amount) {",
				"function debounce(func, wait) {",
			],
			result: "The nested-directory search found the utility functions `formatCurrency` and `debounce`.",
			id: "call_search_files_nested_002",
		},
		{
			userMessagePattern: "import and export statements",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"(import|export).*","file_pattern":"*.{js,ts}"}',
			toolCallId: "call_search_files_complex_regex_001",
			expected: [
				"# search-files-tool-fixture/search-fixture.js",
				"export { calculateTotal, validateUser }",
				"module.exports = { formatCurrency, debounce }",
			],
			result: "The import/export search found the `export` statement in the JavaScript fixture module.",
			id: "call_search_files_complex_regex_002",
		},
		{
			userMessagePattern: "nonExistentPattern12345 and report that there are no matches",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"nonExistentPattern12345"}',
			toolCallId: "call_search_files_no_match_001",
			expected: ["No results found"],
			result: "No matches were found for `nonExistentPattern12345` in the search fixture directory.",
			id: "call_search_files_no_match_002",
		},
		{
			userMessagePattern: "TypeScript class definitions and async methods",
			toolName: "search_files",
			arguments:
				'{"path":"search-files-tool-fixture","regex":"(class\\\\s+\\\\w+|async\\\\s+\\\\w+)","file_pattern":"*.ts"}',
			toolCallId: "call_search_files_class_method_001",
			expected: [
				"# search-files-tool-fixture/search-fixture.ts",
				"class UserService {",
				"async getUser(id: number): Promise<User> {",
			],
			result: "The class-and-method search found `UserService` and its async `getUser` method in the TypeScript fixture.",
			id: "call_search_files_class_method_002",
		},
	]

	for (const fixture of fixtures) {
		mock.addFixture({
			match: {
				userMessage: new RegExp(fixture.userMessagePattern),
			},
			response: {
				toolCalls: [
					{
						name: fixture.toolName,
						arguments: fixture.arguments,
						id: fixture.toolCallId,
					},
				],
			},
		})

		mock.addFixture({
			match: {
				toolCallId: fixture.toolCallId,
				predicate: (req) => toolResultContains(req, fixture.toolCallId, fixture.expected),
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: fixture.result }),
						id: fixture.id,
					},
				],
			},
		})
	}
}
