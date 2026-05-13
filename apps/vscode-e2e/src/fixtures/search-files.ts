import { LLMock } from "@copilotkit/aimock"

type SearchFilesFixture = {
	userMessagePattern: string
	toolName: string
	arguments: string
	toolCallId: string
	result: string
	id: string
}

export function addSearchFilesResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: SearchFilesFixture[] = [
		{
			userMessagePattern: "SEARCH_FILES_FUNCTIONS_SMOKE",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"function\\\\s+\\\\w+"}',
			toolCallId: "call_search_files_functions_001",
			result: "The function search found declarations including `calculateTotal`, `validateUser`, and `formatCurrency`.",
			id: "call_search_files_functions_002",
		},
		{
			userMessagePattern: "SEARCH_FILES_TODO_SMOKE",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"TODO.*"}',
			toolCallId: "call_search_files_todo_001",
			result: "The TODO search found matching TODO entries in the fixture files, including the validation and user-fetching notes.",
			id: "call_search_files_todo_002",
		},
		{
			userMessagePattern: "SEARCH_FILES_TYPESCRIPT_SMOKE",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"interface\\\\s+\\\\w+","file_pattern":"*.ts"}',
			toolCallId: "call_search_files_typescript_001",
			result: "The TypeScript-only search found the `User` and `Product` interface definitions.",
			id: "call_search_files_typescript_002",
		},
		{
			userMessagePattern: "SEARCH_FILES_JSON_SMOKE",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"\\"\\\\w+\\":\\\\s*","file_pattern":"*.json"}',
			toolCallId: "call_search_files_json_001",
			result: "The JSON search found configuration keys such as `name`, `version`, and `dependencies` in `search-config.json`.",
			id: "call_search_files_json_002",
		},
		{
			userMessagePattern: "SEARCH_FILES_NESTED_SMOKE",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"function\\\\s+(format|debounce)"}',
			toolCallId: "call_search_files_nested_001",
			result: "The nested-directory search found the utility functions `formatCurrency` and `debounce`.",
			id: "call_search_files_nested_002",
		},
		{
			userMessagePattern: "SEARCH_FILES_COMPLEX_REGEX_SMOKE",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"(import|export).*","file_pattern":"*.{js,ts}"}',
			toolCallId: "call_search_files_complex_regex_001",
			result: "The import/export search found the `export` statement in the JavaScript fixture module.",
			id: "call_search_files_complex_regex_002",
		},
		{
			userMessagePattern: "SEARCH_FILES_NO_MATCH_SMOKE",
			toolName: "search_files",
			arguments: '{"path":"search-files-tool-fixture","regex":"nonExistentPattern12345"}',
			toolCallId: "call_search_files_no_match_001",
			result: "No matches were found for `nonExistentPattern12345` in the search fixture directory.",
			id: "call_search_files_no_match_002",
		},
		{
			userMessagePattern: "SEARCH_FILES_CLASS_METHOD_SMOKE",
			toolName: "search_files",
			arguments:
				'{"path":"search-files-tool-fixture","regex":"(class\\\\s+\\\\w+|async\\\\s+\\\\w+)","file_pattern":"*.ts"}',
			toolCallId: "call_search_files_class_method_001",
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
