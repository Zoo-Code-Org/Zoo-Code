import { LLMock } from "@copilotkit/aimock"

type ListFilesFixture = {
	userMessagePattern: string
	toolName: string
	arguments: string
	toolCallId: string
	result: string
	id: string
}

export function addListFilesResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: ListFilesFixture[] = [
		{
			userMessagePattern: "LIST_FILES_NON_RECURSIVE_SMOKE",
			toolName: "list_files",
			arguments: '{"path":"list-files-tool-fixture","recursive":false}',
			toolCallId: "call_list_files_non_recursive_001",
			result: "The non-recursive listing for `list-files-tool-fixture` includes `root-file-1.txt`, `root-file-2.js`, `config.yaml`, `README.md`, `.hidden-file`, and the `nested/` directory.",
			id: "call_list_files_non_recursive_002",
		},
		{
			userMessagePattern: "LIST_FILES_RECURSIVE_SMOKE",
			toolName: "list_files",
			arguments: '{"path":"list-files-tool-fixture","recursive":true}',
			toolCallId: "call_list_files_recursive_001",
			result: "The recursive listing for `list-files-tool-fixture` reached the nested structure and includes `nested/`, `deep/`, and `deep-nested-file.ts`.",
			id: "call_list_files_recursive_002",
		},
		{
			userMessagePattern: "LIST_FILES_SYMLINK_SMOKE",
			toolName: "list_files",
			arguments: '{"path":"list-files-symlink-fixture","recursive":false}',
			toolCallId: "call_list_files_symlink_001",
			result: "The symlink fixture listing shows the original `source/` directory and its `source-file.txt`, alongside the symlinked entries in `list-files-symlink-fixture`.",
			id: "call_list_files_symlink_002",
		},
		{
			userMessagePattern: "LIST_FILES_WORKSPACE_ROOT_SMOKE",
			toolName: "list_files",
			arguments: '{"path":".","recursive":false}',
			toolCallId: "call_list_files_workspace_root_001",
			result: "The workspace root listing includes top-level directories like `apps/` and `packages/`, plus files such as `README.md`.",
			id: "call_list_files_workspace_root_002",
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
