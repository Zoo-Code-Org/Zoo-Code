# ADR 0001: Standardize Dependency Management and Feature Lifecycles

- **Status:** Proposed
- **Date:** 2026-09-30
- **Discussion:** [#1868](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1868)

## Context

Dependency and resource management are implemented separately across managers, repositories, and other components. Similar initialization and cleanup logic appears in [Code Index](../../src/services/code-index/manager.ts) and [the webview provider](../../src/core/webview/ClineProvider.ts), but without a consistent lifecycle contract.

For example, the Code Index manager combines feature behavior with dependency creation, replacement, and cleanup. This mixes responsibilities and makes it difficult to verify that every resource is released, especially when initialization fails or dependencies are replaced. Inconsistent cleanup logic increases the risk of leaks and makes them harder to detect.

We need a shared approach to dependency management and resource ownership so that each feature does not have to implement its own lifecycle mechanisms.

## Proposal

**Use explicit composition and shared lifecycle management without adopting a DI framework.**

- Use ordinary classes, constructor injection, and promise-based APIs. Composition Roots construct and connect services; a small shared lifecycle mechanism handles initialization and cleanup.
- Declare construction dependencies and initialization ordering separately. Validate both graphs; compare an explicit initialization DAG with ordered stages. Parallel startup is optional.
- Initialize once under concurrent access; publish services only when ready. Define failure/retry behavior and clean up partial initialization.
- Use explicit, nested ownership scopes and dependency-safe disposal. Features declare public exports, not container access; several features may share a scope. Consumers do not dispose borrowed services.
- Keep long-running indexing separate from readiness. Its owner cancels and awaits background work before releasing dependencies.

## Alternatives considered

- **DI frameworks and broader runtimes (Effect, typed-inject, Awilix, Knifecycle):** not proposed for adoption. For our needs, their abstractions and integration costs are not justified, and framework-specific patterns risk spreading into services and application flow.
- **Per-feature lifecycle code:** preserves local control but continues the duplication and inconsistent cleanup described above.

Prefer explicit composition with reusable lifecycle primitives, not a custom general-purpose DI framework. A cleanup scope alone is insufficient: readiness, initialization ordering, and failure handling still need shared contracts.

## Consequences

Services remain independent of DI infrastructure, with less repeated lifecycle code. We take responsibility for maintaining and testing the shared lifecycle mechanism; construction stays explicit. Readiness gates cannot invalidate retained references after disposal; strict protection needs runtime checks.

## Validation

See the [minimal scope lifecycle API sketch](examples/scope-lifecycle.md), inspired by yx_scope.

Validate this approach in a small Code Index experiment using existing services. Test separate construction and initialization ordering, concurrent access, failure cleanup, workspace isolation, and shutdown during scanning. Preserve behavior and non-blocking activation; check that the shared mechanism removes duplication without becoming another framework.

**Out of scope:** project-wide migration and Task state-machine changes. XState may coexist with the solution; assess it separately against the [Task lifecycle model](../architecture/task-lifecycle-model.md).
