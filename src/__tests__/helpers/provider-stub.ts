import { ClineProvider } from "../../core/webview/ClineProvider"
import { TaskRegistry } from "../../core/task/TaskRegistry"
import { type Task } from "../../core/task/Task"

type ProviderStubFields = {
	delegationTransitionLocks?: Map<string, Promise<void>>
	cancelledDelegationChildIds?: Set<string>
	log?: ReturnType<typeof vi.fn>
	taskHistoryStore?: { get: (id: string) => unknown }
	taskRegistry?: TaskRegistry
	clineStack?: Task[]
	tasks?: Task[]
	runDelegationTransition?: unknown
	removeClineFromStack?: unknown
	evictCurrentTask?: unknown
	restoreParentOrReleasePermit?: unknown
	handleModeSwitchForChild?: unknown
	handleModeSwitch?: (newMode: string, targetTask?: unknown) => Promise<unknown>
}

type PrivateProviderMethods = {
	runDelegationTransition: (this: unknown, ...args: unknown[]) => unknown
	removeClineFromStack: (this: unknown, ...args: unknown[]) => unknown
	evictCurrentTask: (this: unknown, ...args: unknown[]) => unknown
	restoreParentOrReleasePermit: (this: unknown, ...args: unknown[]) => unknown
	handleModeSwitchForChild: (this: unknown, ...args: unknown[]) => unknown
}

export function bindRestoreParentOrReleasePermit(provider: ClineProvider): void {
	const s = provider as unknown as ProviderStubFields
	const proto = ClineProvider.prototype as unknown as PrivateProviderMethods
	s.restoreParentOrReleasePermit = proto.restoreParentOrReleasePermit.bind(s)
}

export function bindHandleModeSwitchForChild(provider: ClineProvider): void {
	const s = provider as unknown as ProviderStubFields
	s.handleModeSwitchForChild = async (newMode: string, targetTask?: unknown) => {
		if (targetTask === undefined) {
			await s.handleModeSwitch?.(newMode)
		} else {
			await s.handleModeSwitch?.(newMode, targetTask)
		}
		return { apiConfiguration: {}, mode: newMode, apiConfigName: "default" }
	}
}

export function bindDelegationMethods(provider: ClineProvider): void {
	bindRestoreParentOrReleasePermit(provider)
	bindHandleModeSwitchForChild(provider)
}

/**
 * Augments a plain stub object with the instance fields and bound methods that
 * ClineProvider methods read from `this` (runDelegationTransition,
 * delegationTransitionLocks, cancelledDelegationChildIds, cancellingDelegationChildIds),
 * so tests can call private ClineProvider methods against a plain object
 * without instantiating a real ClineProvider.
 *
 * Pass `tasks` (array of Task mocks) to pre-seed the registry in stack order.
 * The legacy `clineStack` key is accepted and converted automatically.
 */
export function makeProviderStub<T extends object>(stub: T): ClineProvider {
	const s = stub as T & ProviderStubFields
	const proto = ClineProvider.prototype as unknown as PrivateProviderMethods
	s.delegationTransitionLocks ??= new Map()
	s.cancelledDelegationChildIds ??= new Set()
	s.log ??= vi.fn()
	s.taskHistoryStore ??= { get: () => undefined }

	// Convert legacy clineStack array into a TaskRegistry
	if (!s.taskRegistry) {
		const registry = new TaskRegistry()
		const seed: Task[] = s.clineStack ?? s.tasks ?? []
		for (const t of seed) registry.push(t)
		s.taskRegistry = registry
	}
	delete s.clineStack

	s.runDelegationTransition ??= proto.runDelegationTransition.bind(s)
	s.removeClineFromStack ??= proto.removeClineFromStack.bind(s)
	s.evictCurrentTask ??= proto.evictCurrentTask.bind(s)
	if (!s.restoreParentOrReleasePermit) {
		bindRestoreParentOrReleasePermit(s as unknown as ClineProvider)
	}
	if (!s.handleModeSwitchForChild) {
		bindHandleModeSwitchForChild(s as unknown as ClineProvider)
	}
	return s as unknown as ClineProvider
}
