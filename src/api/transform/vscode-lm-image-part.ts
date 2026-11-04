import * as vscode from "vscode"

/** Shape of `vscode.LanguageModelDataPart`, whose typings postdate our minimum VS Code version. */
export interface ImagePart {
	readonly mimeType: string
	readonly data: Uint8Array
}

export type UserMessagePart = vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | ImagePart

type ImagePartFactory = (data: Uint8Array, mimeType: string) => ImagePart

/** Resolved per call because the host, not this bundle, decides whether image parts exist. */
function resolveImagePartFactory(): ImagePartFactory | undefined {
	const dataPart: unknown = Reflect.get(vscode, "LanguageModelDataPart")
	const image: unknown = typeof dataPart === "function" ? Reflect.get(dataPart, "image") : undefined
	return typeof image === "function"
		? (data, mimeType) => Reflect.apply(image, dataPart, [data, mimeType])
		: undefined
}

export function canCreateImageParts(): boolean {
	return resolveImagePartFactory() !== undefined
}

/** Returns undefined on hosts that cannot carry image data. */
export function createImagePart(data: Uint8Array, mimeType: string): ImagePart | undefined {
	return resolveImagePartFactory()?.(data, mimeType)
}

export function createUserMessage(parts: UserMessagePart[]): vscode.LanguageModelChatMessage {
	// Hosts that support image parts accept them as content; the older typings just do not declare them.
	return vscode.LanguageModelChatMessage.User(
		parts as Exclude<Parameters<typeof vscode.LanguageModelChatMessage.User>[0], string>,
	)
}
