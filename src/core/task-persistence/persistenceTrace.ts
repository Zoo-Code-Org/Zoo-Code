// Keep the task-persistence import path while sharing the sink with JSON I/O.
export {
	setPersistenceTraceSink,
	tracePersistenceEvent,
	type PersistenceTraceStage,
	type PersistenceTraceFields,
} from "../../utils/persistenceTrace"
