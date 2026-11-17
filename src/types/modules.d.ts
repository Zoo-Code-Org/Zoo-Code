/**
 * Ambient type declarations for environment, runtime, and third-party dependencies.
 * Resolves editor and compiler diagnostics in standalone environments where node_modules
 * has not yet been populated via pnpm install.
 */

// Node.js ambient built-in modules
declare module "path" {
	const path: any
	export = path
}

declare module "os" {
	const os: any
	export = os
}

declare module "crypto" {
	const crypto: any
	export = crypto
}

declare module "events" {
	export default class EventEmitter<T = any> {
		on<K extends keyof T>(event: K | (string & {}) | symbol, listener: (...args: any[]) => any): this
		off<K extends keyof T>(event: K | (string & {}) | symbol, listener: (...args: any[]) => any): this
		emit<K extends keyof T>(event: K | (string & {}) | symbol, ...args: any[]): boolean
		addListener<K extends keyof T>(event: K | (string & {}) | symbol, listener: (...args: any[]) => any): this
		removeListener<K extends keyof T>(event: K | (string & {}) | symbol, listener: (...args: any[]) => any): this
		removeAllListeners(event?: keyof T | (string & {}) | symbol): this
		setMaxListeners(n: number): this
		getMaxListeners(): number
		listeners(event: keyof T | (string & {}) | symbol): Function[]
		rawListeners(event: keyof T | (string & {}) | symbol): Function[]
		listenerCount(event: keyof T | (string & {}) | symbol): number
		prependListener<K extends keyof T>(event: K | (string & {}) | symbol, listener: (...args: any[]) => any): this
		prependOnceListener<K extends keyof T>(event: K | (string & {}) | symbol, listener: (...args: any[]) => any): this
		eventNames(): Array<keyof T | (string & {}) | symbol>
		[key: string]: any
	}
}

declare namespace NodeJS {
	interface Timeout {}
	interface Immediate {}
	interface Process {}
	interface ProcessEnv {
		[key: string]: string | undefined
	}
}

declare const process: any
declare const Buffer: any
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): NodeJS.Immediate
declare function clearImmediate(immediateId: NodeJS.Immediate): void

// VS Code extension host types
declare module "vscode" {
	const vscode: any
	export = vscode
}

// Third-party packages
declare module "uuid" {
	export const v7: () => string
	export const v4: () => string
}

declare module "@anthropic-ai/sdk" {
	export class Anthropic {
		static Messages: any
		[key: string]: any
	}
	export namespace Anthropic {
		export type TextBlockParam = any
		export type ToolUseBlockParam = any
		export type Messages = any
	}
}

declare module "openai" {
	export default class OpenAI {
		[key: string]: any
	}
	export namespace OpenAI {
		export type Chat = any
	}
}

declare module "lodash.debounce" {
	const debounce: any
	export default debounce
}

declare module "delay" {
	const delay: any
	export default delay
}

declare module "p-wait-for" {
	const pWaitFor: any
	export default pWaitFor
}

declare module "serialize-error" {
	export const serializeError: any
}

declare module "vitest" {
	export const describe: any
	export const it: any
	export const test: any
	export const expect: any
	export const beforeEach: any
	export const afterEach: any
	export const beforeAll: any
	export const afterAll: any
	export const vi: any
}
