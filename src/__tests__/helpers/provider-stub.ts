import { ClineProvider } from "../../core/webview/ClineProvider"

/**
 * Augments a plain stub object with the instance fields and bound methods that
 * ClineProvider methods read from `this` (runDelegationTransition,
 * delegationTransitionLocks, cancelledDelegationChildIds, cancellingDelegationChildIds),
 * so tests can call private methods via `(ClineProvider.prototype as any).method.call(stub, …)`
 * without instantiating a real ClineProvider.
 */
export function makeProviderStub<T extends object>(stub: T): T {
	const s = stub as any
	const proto = ClineProvider.prototype as any
	s.delegationTransitionLocks ??= new Map()
	s.cancelledDelegationChildIds ??= new Set()
	s.log ??= vi.fn()
	s.taskHistoryStore ??= { get: () => undefined }
	s.runDelegationTransition = proto.runDelegationTransition.bind(s)
	s.removeClineFromStack ??= proto.removeClineFromStack.bind(s)
	s.evictCurrentTask ??= proto.evictCurrentTask.bind(s)
	return s
}
