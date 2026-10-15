# Migration diagnostic compatibility review

This review compares the migration diagnostic changes in #281, #282, and #283 with
`df73647`, the implementation before #280 began. The two production implementation
commits are `9cf5c7c` (#281) and `47001a2` (#282); neither includes unrelated work.
The review follows [ADR 0003](adr/0003-expected-errors-and-defects.md).

## Ownership after the change

| Source                                       | Responsibility retained                                                                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/migrations/migrationDiagnostics.ts`     | Own-cause presence, primary cause selection, defect preservation, diagnostic fallback, retryability precedence, and ordered cleanup merging. It exports only `enrichMigrationError` and `migrationExecutionError` internally. |
| `src/ddl/migrate.ts`                         | Phase and preview messages, provider release observation, temporary wrapper provenance, cleanup transfer, and preview unwrapping.                                                                                             |
| `src/dialects/postgres/migration/runtime.ts` | Expected-error classification, stage and outcome selection, action messages, cancellation, transaction and lock handling, and session disposal.                                                                               |
| `src/dialects/sqlite/migration/runtime.ts`   | Expected-error classification, validation-stage precedence, outcome selection, message wording, lock retry, rollback and commit, policy restoration, and session disposal.                                                    |
| `src/operations/coordinator.ts`              | Provider-release cleanup storage and transfer.                                                                                                                                                                                |

All four original reconstruction paths now call the shared module: phase enrichment and
provider-release cleanup call `enrichMigrationError`; PostgreSQL and SQLite execution call
`migrationExecutionError`. The previous PostgreSQL cause, retryability, and defect helpers
and SQLite defect helper are gone. No coordinator, dialect, or public-barrel import was
added to the shared module. The public declaration build exposes neither shared function.

## Exact message comparison

The modified caller tests below pass unchanged against both the current stack and the
`df73647` source. These exact strings are asserted through caller behavior; the source
comparison also confirmed that release cleanup appends evidence without changing the
primary message.

| Path                                                                      | Exact message on both implementations                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Phase enrichment of a structured planning failure                         | `Migration planning failed: defect with explicit undefined cause`                                   |
| Primitive planning defect with provider-release failure                   | `Migration planning failed`                                                                         |
| Preview conversion of a raw `QueryError`                                  | `Migration introspection failed: preview query failed`                                              |
| Preview conversion of a raw `DriverError`                                 | `Migration introspection failed`                                                                    |
| PostgreSQL execution of an introspection defect                           | `PostgreSQL migration introspection failed: Migration introspection failed`                         |
| PostgreSQL execution of a planning defect                                 | `PostgreSQL migration planning failed: Migration planning failed`                                   |
| Generic unstructured adapter execution failure                            | `Migration DDL execution failed`                                                                    |
| Provider-open failure                                                     | `Migration operation session failed`                                                                |
| Provider release after an applied migration                               | `Migration session cleanup failed: provider release failed`                                         |
| Provider release after PostgreSQL DDL failure                             | `PostgreSQL migration ddl failed during action 1`                                                   |
| PostgreSQL one-try lock timeout                                           | `PostgreSQL migration lock failed: Migration advisory lock was not available after one no-wait try` |
| PostgreSQL cancellation during action 1                                   | `PostgreSQL migration ddl failed during action 1: Migration execution was aborted`                  |
| PostgreSQL reported validation failure                                    | `PostgreSQL migration validation failed: validation rejected`                                       |
| SQLite reported preparation failure                                       | `SQLite migration planning failed: preparation failed`                                              |
| SQLite validation, including precedence over an existing `lowering` stage | `SQLite migration validation failed: convergence failed`                                            |
| SQLite integrity validation                                               | `SQLite migration validation failed: SQLite integrity_check failed`                                 |
| SQLite DDL action 1                                                       | `SQLite migration ddl failed during action 1`                                                       |
| SQLite uncertain commit                                                   | `SQLite migration commit failed`                                                                    |
| SQLite post-commit policy cleanup                                         | `SQLite migration sessionCleanup failed`                                                            |

The `DriverError` detail remains in the cause and is omitted from the preview message.
Action numbers remain one-based in messages while `actionIndex` remains zero-based.

## Diagnostic and execution comparison

- Phase enrichment keeps a missing cause absent. Explicit `undefined` and `null` causes
  remain own properties. An existing empty cleanup array remains present through phase
  enrichment. Enrichment does not mark an expected `MigrationError` as a defect.
- Execution uses an incoming `MigrationError` itself as cause when it has no own cause.
  An existing own cause, defect marker, source indexes, capability issues, and primary
  defect stack survive wrapping. Supplied action and source provenance take precedence;
  missing supplied fields retain structured values.
- Structured retryability takes precedence over an adapter's supplied value, including
  `false` over `true`. An `unknown` database outcome forces `retryable: false`.
  Cleanup appends existing then new evidence without deduplication. An empty structured
  cleanup list is omitted by PostgreSQL execution; SQLite retains its explicit own
  `cleanupFailures: undefined` property. SQLite also retains own `actionIndex`,
  `sourceStepIndexes`, and `capabilityIssues` properties when their values are undefined.
- PostgreSQL retains a reported structured stage; SQLite's validation stage takes
  precedence. Raw expected errors remain unmarked, while unexpected execution errors
  carry `defect: true` and their original cause. Rollback and commit outcomes, lock
  cancellation, restoration, and session disposal remain adapter decisions.
- Preview preserves object-defect identity and stack when release fails by transferring
  cleanup evidence to the original object. A primitive defect with release failure stays
  in a structured wrapper with the primitive cause and cleanup evidence. Pre-existing
  `MigrationError` values are not eligible for temporary-wrapper unwrapping. When release
  adds no cleanup, the existing error keeps its identity.

The direct module tests cover the cause and diagnostic combinations. Caller tests retain
preview provenance, cleanup transfer, dialect outcomes and classification, cancellation,
restoration, and session disposal. Each dialect keeps one representative explicit nullish
cause case; the direct tests cover both `null` and `undefined` for both operations.

## Verification

Local environment: Node `v24.12.0`; PostgreSQL at
`postgresql://test:test@localhost:5432/db0`; SQLite uses Node's built-in driver.
No environment limitation affected the checks.

| Command                                                                                                                                            | Result                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:unit`                                                                                                                                   | 84 files, 1,545 tests passed; includes architecture checks.                                                                                           |
| `pnpm typecheck`                                                                                                                                   | Passed.                                                                                                                                               |
| `pnpm lint`                                                                                                                                        | Passed.                                                                                                                                               |
| `pnpm fmt:check`                                                                                                                                   | Passed.                                                                                                                                               |
| `pnpm test:integration:postgres` with `POSTGRESQL_URL` set in the process                                                                          | 7 files, 25 tests passed.                                                                                                                             |
| `pnpm test:integration:sqlite`                                                                                                                     | 4 files, 43 tests passed.                                                                                                                             |
| `git diff --check`                                                                                                                                 | Passed.                                                                                                                                               |
| `node node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts` on the four modified caller test files in the detached `df73647` worktree | 4 files, 96 tests passed against pre-refactor source. The direct shared-module tests were excluded because that module did not exist at the baseline. |
| `pnpm build`                                                                                                                                       | Passed; `dist/index.d.ts` contains no shared diagnostics exports.                                                                                     |

CI for [#284](https://github.com/javangriff/stratom/pull/284) and
[#285](https://github.com/javangriff/stratom/pull/285) passed on Node 24 and the supported
minimum Node 22.5.0, including both dialect integration suites.

Message standardization could be a separate follow-up. In particular, `sessionCleanup`
and repeated `Migration ... failed` phrases read differently across paths. This review
preserves their wording.

## Follow-up for #288 and #289 (2026-10-16)

The verification above describes the code before #288. The #288 simplification changed
two presence checks in `enrichMigrationError`. #289 restores the rules in `52e4129`:
only an own `cause` is copied, and `actionIndex: 0` is retained. The two-operation
interface, messages, diagnostic fields, and ownership in the table above are unchanged.

Direct regression tests now cover action indexes 0 and 2 in phase and cleanup
enrichment. They also cover inherited `cause` values through both enrichment paths.
An inherited cause does not become an own property. Execution then keeps the enriched
error itself as its cause. Explicit own `null` and `undefined` causes stay present
through enrichment and execution. The public PostgreSQL execution test checks that a
first-action DDL failure keeps `actionIndex: 0`, its primary cause and stack, and its
provider-release cleanup cause with the same message.

Before the production fix, the two affected unit files had five failed tests and 23
passed tests. The failures covered zero phase and cleanup indexes, inherited causes
in both enrichment paths, and the public provider-release path. After the fix, all
28 tests in those files passed. This follow-up tests the #288 regression against the
current code. It does not repeat the earlier cross-version comparison.

The follow-up checks ran on Node `v24.12.0` with PostgreSQL at
`postgresql://test:test@localhost:5432/db0`.

| Check                                               | Result                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| Affected unit files, before the fix                 | 2 files, 5 failed and 23 passed tests.                           |
| Affected unit files, after the fix                  | 2 files, 28 passed tests.                                        |
| `pnpm test:unit`                                    | 84 files, 1,549 passed tests, including architecture checks.     |
| `pnpm typecheck`, `pnpm lint`, and `pnpm fmt:check` | Passed.                                                          |
| `pnpm test:integration:postgres`                    | 7 files, 25 passed tests.                                        |
| `pnpm test:integration:sqlite`                      | 4 files, 43 passed tests.                                        |
| `pnpm build` and `git diff --check`                 | Passed. The public declaration has no shared diagnostic exports. |

The first SQLite integration run overlapped with `pnpm build`. Both builds wrote
`dist`, and the SQLite package test failed while removing one declaration file.
The SQLite suite passed when run alone. This was a build-output race, not a test
failure in the migration behavior.
