# Physical column renames: investigation and implementation plan

Status: proposed, for [#300](https://github.com/stratom-ts/stratom/issues/300).
Inspected main at `85c213f59b45c290a314fad6cb15f5092873b6a1` on 2026-11-09.
This document recommends future behavior. It does not add a supported API.

## Recommendation

Extend [#38](https://github.com/stratom-ts/stratom/issues/38) with explicit,
per-migration physical column rename context. Use native column rename statements,
not copying followed by dropping. Keep intent outside table metadata. Do not add
stable column IDs, former-name history, a ledger, callbacks, or migration-managed
raw SQL in this first implementation.

Explicit intent preserves pure planning, complete previews, and whole-plan lowering.
Raw SQL also needs unknown-effect, arbitrary-privilege, and replay contracts.

Application-only renames already work through `column({ name: 'displayName' })`.
See [column-names.md](column-names.md). Both #299 and #303 are closed at this
baseline. This proposal changes storage to `fullName`. It does not change query
aliasing or the application-to-storage mapping rules.

## Current behavior and seams

- [migrationPlan.ts](../src/ddl/migrationPlan.ts) matches canonical physical column
  names. A changed physical name yields an addition, and complete ownership can
  also yield a drop. Additive ownership retains the old column.
- [migrate.ts](../src/ddl/migrate.ts) exposes asynchronous `db.migrate().plan()`,
  `dryRun()`, and `execute()`. These observe a catalog. The internal
  `planMigration()` function is pure and synchronous. Public `plan()` is read-only,
  not an I/O-free function.
- [planningCatalog.ts](../src/ddl/planningCatalog.ts) validates catalog coverage
  and projects dependency evidence. Unknown evidence is not proof of absence.
- [migrationProgram.ts](../src/ddl/migrationProgram.ts) requires whole-plan
  lowering. Physical actions retain `sourceStepIndexes`, transaction requirements,
  and preconditions. Lowering checks the executing Semantic Profile.
- The PostgreSQL runtime prepares twice, first provisionally and then inside its
  transaction. Guarded column drops acquire relation locks before authoritative
  preparation. It currently does **not** invoke the supplied final `validate`
  callback. SQLite prepares inside its writer transaction and invokes that callback
  after foreign-key and integrity checks.
- Column drops default to a data guard. `allow('dangerouslyDropColumn')` bypasses
  that guard. It never transfers old values to a new column. Other existing
  destructive permissions are `dropTable` and `dropIndex`.

## Alternatives against the example

| Approach         | `displayName` to `fullName`                                                     | Preview and repeated startup execution                                                                                        | Decision                                                     |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Explicit context | Produce one semantic rename and native `ALTER TABLE`                            | Predict catalog name substitution without executing SQL. Skip an already-satisfied rename after observation.                  | Recommend.                                                   |
| Raw SQL alone    | Author `ALTER TABLE "public"."users" RENAME COLUMN "displayName" TO "fullName"` | SQL alone fails on repeat. It needs guards, verification, and a phase or declared projection before generated reconciliation. | Defer.                                                       |
| Combined         | Typed rename for this example, raw actions for exceptional changes              | Rename stays predictable. Raw actions still need separate preview, permissions, provenance, and idempotency contracts.        | No additional benefit for this example. Defer raw component. |

`formerNames` would retain historical intent in every schema and still need
ambiguity rules. Stable IDs need durable database identity evidence. Extend #38
with explicit context instead of adding either identity mechanism or similarity guesses.

## Proposed public API

The following syntax is proposed. `User` is the registered desired table whose
physical column is now `fullName`.

```ts
const User = defineTable(
  'users',
  { id: string(), fullName: nullable(string()) },
  { primaryKey: 'id' },
)

// db was created with User in its registered desired schema.
const migration = db.migrate().renameColumn({
  table: User,
  from: 'displayName',
  to: 'fullName',
})

const plan = await migration.plan()
const preview = await migration.dryRun()
await migration.execute({ signal, lockTimeoutMs: 5_000 })
await migration.execute() // No rename action if storage already matches.
```

`table` must be a registered desired table handle in the current ownership scope.
Both names are **physical** identifiers. They are not application-property lookup
keys. With `column({ name: 'full_name' })`, the destination is `full_name`.
There is one relation per intent, so moving columns between relations cannot be
expressed. Resolve the handle through the existing canonical identity adapter and
namespace context, never a dotted string or a shared `public` fallback.

Snapshot intent at each public invocation. Never mutate shared table handles.
Residual destructive steps retain their permissions. A rename needs no destructive
`allow()` because it preserves values. Native privileges still apply.

## Intent resolution and idempotency

Validate the entire intent set before producing any Migration Plan. Identifier
comparison follows the relation's dialect adapter. Validate physical identifier
limits and reject malformed runtime input as authored-schema errors.

| Authoritative catalog and intent                                                    | Result                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Source exists, destination absent, existing managed table                           | Plan a rename. Compare the projected destination definition with desired storage and plan supported residual alterations.                       |
| Source absent, destination exists                                                   | Treat the rename as already satisfied. Reconcile the actual destination normally. Unsupported drift still rejects the whole plan.               |
| Both names exist                                                                    | Conflict. Never merge, overwrite, drop, or copy values.                                                                                         |
| Neither exists on an existing table                                                 | Conflict. Never substitute an addition for a missing source.                                                                                    |
| Desired registered table is absent                                                  | No historical column can exist. Create the desired table normally, without a rename step. Reject a collision with an unmanaged object.          |
| Destination absent from desired physical columns, or source still desired           | Reject contradictory intent.                                                                                                                    |
| Identical comparison keys, including SQLite case-only renames                       | Reject redundant or spelling-only intent in the first API. PostgreSQL distinct quoted names remain distinct.                                    |
| Duplicate identical intent                                                          | Deduplicate before ordering.                                                                                                                    |
| One source to multiple destinations, or multiple sources to one destination         | Reject ambiguity, even if the current catalog might disambiguate it.                                                                            |
| Independent renames                                                                 | Accept and sort canonically, independent of declaration order.                                                                                  |
| Chains such as `a -> b`, `b -> c`, or cycles/swaps                                  | Reject the entire set. Do not invent temporary names or infer which stage already ran. Separate deployments can author unambiguous transitions. |
| Cross-relation, unregistered, unmanaged, unresolved namespace, or ambiguous targets | Reject before lowering. Expand neither ownership nor registration implicitly.                                                                   |

A destination-only catalog proves structural satisfaction, not historical lineage
or value provenance. Without a ledger, the library cannot distinguish a completed
rename from a manually created matching column. Document this limit. The caller
owns the truth of the source/destination mapping and must remove obsolete intent
before deliberately reusing an old physical name.

Repeated runs reobserve the database under coordination. They skip rename work and
produce an empty Migration Plan when the entire desired schema matches. They do
not skip residual changes merely because the rename itself is satisfied. Fresh
database creation is also repeatable without historical migration records.

## Pure planning and dependency projection

Add a semantic `rename_column` step with one structured destination column
Migration Target and a canonical `from` column identifier on that same relation.
The relation is not encoded twice. Keep SQL out of the Migration Plan.

Resolve and validate all renames against the original authoritative catalog, then
build an immutable projected catalog for normal reconciliation. Substitute physical
column identifiers in column facts, supported primary/unique key members, index
members, local foreign-key members, and incoming foreign-key referenced members.
Do not substitute arbitrary SQL strings, names embedded in expressions, object
names, default strings, or application-property keys. Preserve original catalog
evidence separately for runtime preconditions and diagnostics.

Observe dependency coverage for affected relations and their inbound references.
Do not assume the ordinary requested-table snapshot includes every inbound edge.
Extend dialect catalog observation to provide that evidence or reject the rename
as unsupported. External dependencies remain owned by their owners. Observation
must not grant permission to change those objects independently.

In the first release, reject affected opaque expressions, unresolved views or
triggers, unsupported constraints/index semantics, partition/inheritance behavior,
and incomplete dependency coverage. Even a database-supported rename can exceed
what this planner can prove. SQLite currently reports unresolved view/trigger
dependencies, so do not promise support merely because native ALTER can rewrite
them. Capability rejection precedes all DDL, including earlier independent steps.

Reconcile supported dependency semantics against the projection. Existing
generated-index matching already accepts an unambiguous semantic match. Preserve
historical physical key/index/constraint names when their semantics match after
substitution, including subsequent runs without rename context. Do not regenerate
their names from `fullName` or add hidden object-renaming actions. Authored names
continue to mean exact object names. Ambiguous generated semantic matches reject.

Give `rename_column` a fixed phase after namespace/table creation and before
column alterations, indexes, and foreign-key additions. Sort independent renames
by the existing structured target order, then canonical source identifier with
spelling tie-breaks. Chains are rejected, so this needs no authored execution order.
Equivalent desired schemas, catalogs, and normalized rename sets produce equal
plans within one Semantic Profile. Without intent, current behavior stays intact.

Lower the complete rename-aware plan once before writes. Preserve the original
and projected catalog distinction in `PlannedMigration`; never feed a projected
catalog to runtime source-existence checks. A profile mismatch or unsupported
later step prevents every earlier rename from executing.

Existing runtimes check preconditions before actions. Lower residual data guards
against original physical addresses: a no-null guard for renamed `fullName` must
read existing `displayName`. Preserve destination-step provenance while translating
only the guard address. Reject combinations without a provable original address
before writes. Never issue a pre-action guard against a projected column that does
not exist yet. Test rename plus `set_not_null` with both null and non-null data.

## Preview and execution sequence

1. `plan()` observes a read-only snapshot, resolves intent, projects supported
   catalog effects, and calls pure planning. It does not lower or execute DDL.
2. `dryRun()` performs the same observation, then lowers the whole plan. Include
   native rename SQL, source-step provenance, atomicity, and source/destination
   preconditions. Keep bound values redacted as `[REDACTED]` in order and count.
3. Preview is advisory. Concurrent catalog changes can alter or invalidate the
   authoritative plan. A preview is not an executable token or a lock reservation.
4. `execute()` pins one operation session, validates client execution scope, and
   acquires existing migration coordination. Keep the finite lock deadline and
   cancellation signal across the required lock operations.
5. PostgreSQL provisional preparation identifies a canonical relation lock set
   including rename targets. Acquire necessary relation locks before the first
   authoritative catalog snapshot. Reprepare in the transaction. Reject a newly
   required relation outside that set before writes, as guarded drops already do.
   SQLite obtains its existing writer transaction before authoritative preparation.
6. Reobserve, resolve all intent, check permissions, and lower the whole plan.
   Reject transaction-forbidden or non-plan-atomic actions before writes.
7. Check authoritative source-present/destination-absent rename preconditions under
   the retained relation locks, then execute native statements. Already-satisfied
   intent creates no action. PostgreSQL must apply the remaining lock deadline to
   rename-related DDL waits too, not leave later blocking DDL unbounded.
8. Reobserve on the same session before commit. Run rename postconditions and the
   existing desired-state convergence callback. Require no remaining plan steps.
   Check source absence/destination presence only for renames actually executed.
   Preserve SQLite integrity and foreign-key checks. Add PostgreSQL callback
   invocation at the validation stage before enabling rename support.
9. Commit once, then release coordination and the operation session. Follow existing
   rollback, unlock, restoration, discard, and session-cleanup policies.

Validation proves catalog convergence. Native rename semantics and real database
tests establish value preservation. A catalog cannot prove historical values.

Cancellation before commit or a statement/validation failure triggers rollback.
Report `rolledBack` only after rollback is known to succeed. A failed rollback
must retain uncertainty and discard the session. A commit acknowledgment failure
reports `unknown`, discards the session, and does not automatically replay or
claim rollback. A later invocation reobserves on a fresh session. An applied
migration with cleanup failure must retain `applied` and the cleanup evidence.

Keep `MigrationError` stage, outcome, retryability, `actionIndex`, and
`sourceStepIndexes`. Rename precondition failures use `precondition`, SQL failures
use `ddl`, and verification failures use `validation`. Keep the original cause and
ordered rollback/unlock/session-cleanup failures. Under ADR 0003, unexpected
preview defects preserve identity when cleanup succeeds. Execution envelopes use
`defect: true` and retain the original cause and stack. Never convert a defect
into an unsupported-rename capability result.

## Raw SQL assessment and deferred contract

SQL and parameters can be reviewable physical actions, but cannot automatically
be semantic Migration Plan steps. An untyped action has no legitimate
`sourceStepIndexes` to invent. A future contract needs explicit authored action
identity/provenance distinct from generated-step provenance.

An action ID such as `users.full-name`, SQL, parameters, and pre/postconditions
would still need a phase contract:

| Placement                         | Consequence                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before authoritative observation  | Execution must run under coordination and the transaction, then reobserve. Preview can show raw SQL but cannot know the later generated plan. This revises the whole-run lowering guarantee.      |
| Mixed with generated actions      | Safe only with a trusted, supported semantic projection of catalog effects. An arbitrary caller callback cannot supply a verifiable projection. For a rename, typed intent already provides this. |
| After generated actions           | Can invalidate convergence and dependencies. It needs post-action observation and verification, and does not prevent the original add/drop rename plan.                                           |
| A separate coordinated custom run | Most honest future starting point: preview only its authored statements, execute and verify them, then call normal migration in a later run. Atomicity across both runs is not promised.          |

Recommend a separate design before any raw-action implementation. If callers
require one atomic raw-plus-generated run, explicitly propose an ADR 0002 revision
for phased lowering, or limit raw actions to supported typed projections. Do not
execute SQL speculatively during `prepare()`: PostgreSQL can call it twice.

Keep `planMigration()` pure. A future read-only preview must report unknown later
effects as unknown, or reject an unsupported complete preview. It cannot silently
show the current catalog's generated actions as the post-SQL program. No callbacks
in the initial raw design: a function cannot be reviewed as SQL, can perform
external side effects, and can escape the pinned executor or cancellation scope.

Raw previews redact bound parameter values, including diagnostic serialization.
SQL text itself remains visible and can contain secrets. Require parameters for
values, while identifiers need dialect quoting. Parameterizing identifiers is not
a valid general substitute. Do not promise redaction of literals inside authored SQL.

Require a separate explicit unsafe-SQL permission. Existing `dropTable`,
`dropIndex`, or `dangerouslyDropColumn` permissions cannot classify arbitrary SQL.
Database privileges remain the final authorization boundary. Raw SQL must not
control transactions, release coordination, alter session safety policies, or
perform transaction-forbidden work inside a required atomic run. General SQL
classification cannot prove compliance. Restriction requires a constrained
statement API or a trusted-caller contract with explicit limitations, not a keyword
scanner marketed as enforcement.

Future raw actions must use the pinned session, transaction, deadline, cancellation,
verification, and cleanup rules above. Atomic rollback cannot undo external effects
from functions or other systems. Reject transaction-forbidden declarations before
any statement rather than silently downgrade atomicity.

For startup replay, compare these strategies:

- Catalog pre/postconditions suffice for this structural rename. They cannot prove
  an arbitrary data backfill or external effect already occurred.
- Caller-idempotent SQL repeats on every run unless guards establish satisfaction.
  The caller must prove safe repetition. Do not retry automatically after unknown
  commit outcomes.
- Durable operation tracking can provide an ID, checksum, and completion record
  committed with transactional actions. It adds namespace, ownership, drift,
  concurrency, and lifecycle decisions, and cannot make external effects exactly
  once. Evaluate it with [#12](https://github.com/stratom-ts/stratom/issues/12)
  only when custom persisted migrations are justified. It is not a rename prerequisite.

## Dialect support and compatibility

PostgreSQL supports native `RENAME COLUMN` without changing stored data. ALTER
normally requires an `ACCESS EXCLUSIVE` lock and table ownership. Do not combine
rename with comma-separated alterations. These rules come from the official
[ALTER TABLE reference](https://www.postgresql.org/docs/current/sql-altertable.html).
Preserve supported key/index/FK associations through native rename and semantic
projection. Prove that behavior in the integration suite rather than rebuilding
objects. Names of dependent objects need not follow the new column spelling.

PostgreSQL tracks many catalog dependencies, but function-body text and dynamic
SQL can fall outside that tracking. Do not promise application or stored-code
rewrites. This follows the documented limits of
[dependency tracking](https://www.postgresql.org/docs/current/ddl-depend.html).
Reject partitioned/inherited/foreign relations in the initial rename lowering
unless their full behavior and lock scope are explicitly supported and tested.

SQLite added column rename in
[3.25.0](https://www.sqlite.org/releaselog/3_25_0.html). Native rename updates schema
references in indexes, triggers, and views. Ambiguous trigger/view rewrites fail
without changes, and rename does not rewrite table content. See the official
[ALTER TABLE reference](https://www.sqlite.org/lang_altertable.html).
The ORM's dependency evidence is narrower, so initial support remains limited to
provable ordinary-table cases. Require a supported native SQLite version and
safe schema policies. Never enable `writable_schema` or rely on disabling native
validation to make a rename succeed.

SQLite lowering currently groups relation changes and can select a rebuild.
Add a rename action before residual group actions; construct any subsequent rebuild
from the projected column addresses so copying reads `fullName`. Never let the
old intersection-copy logic discard renamed values. Reject unsupported combinations
before DDL until that mixed path is proven. Keep the current `main`-only migration
restriction. Attached database renames remain unsupported.

This adds a `MigrationStep` union member, planner intent input, precondition variants,
and physical preview output. Exhaustive consumers and extension dialect fixtures
must change together. Unknown rename support must fail lowering, not fall back to
add/drop. The existing Semantic Profile fields stay unchanged because rename
context is an operation input, not an identity adapter or namespace setting.

## Domain and ADR decisions

Preserve ADR 0001 canonical relation identity and ADR 0003 expected-error/defect
rules. Extend ADR 0002 with the new step payload, normalized intent as a planning
input, phase ordering, and original/projected catalog separation. Its pure planning,
structured targets, profile checking, and whole-plan lowering guarantees remain.
Do not mark this proposal accepted without the implementation design review.

No new glossary term is necessary. Use Migration Plan, Migration Target, and
Semantic Profile as defined in `CONTEXT.md`. Table renames could later use similar
intent resolution, but relation identity and dependent-name projection need a
separate design. They are not part of #38's proposed implementation.

## Implementation plan and ticket boundaries

Use #38 for one complete physical-rename feature, with the following reviewable
commits. Do not ship a planner-only path that still executes add/drop. No follow-up
tickets are created by this investigation.

1. Record the ADR 0002 extension and public API in #38. Add builder input types in
   [migrate.ts](../src/ddl/migrate.ts), wire snapshots through planning/execution,
   and update public/type export fixtures. Validate identifiers, ownership, and
   contradictory intent before lowering. Done when public planning rejects the
   conflict matrix and handles fresh/already-applied schemas deterministically.
2. Add canonical rename resolution, projection, and step ordering in
   [migrationPlan.ts](../src/ddl/migrationPlan.ts) and
   [planningCatalog.ts](../src/ddl/planningCatalog.ts). Retain original evidence
   beside the projection. Extend [catalog.ts](../src/dialects/catalog.ts) and each
   dialect's catalog observation for required dependency evidence. Done when
   reordered registrations/renames yield equal plans, supported dependencies
   project correctly, and unknown coverage fails before any writes.
3. Extend [migrationProgram.ts](../src/ddl/migrationProgram.ts) with rename
   preconditions and both dialect lowerers under `src/dialects/*/migration/` with
   native statements and residual-action addressing. Update the extension dialect
   contract fixture at the same time. Done when whole-plan previews show rename
   provenance and unsupported later work prevents all execution.
4. Extend PostgreSQL relation lock collection and add its missing final validation
   invocation in [runtime.ts](../src/dialects/postgres/migration/runtime.ts).
   Implement rename preconditions and diagnostics in both runtimes, retaining
   [migrationDiagnostics.ts](../src/migrations/migrationDiagnostics.ts) behavior.
   Done when a forced validation failure rolls back a real rename and an uncertain
   commit retains its outcome without retry.
5. Prove native value and dependency preservation, repeat-run convergence, and
   SQLite mixed rebuild behavior. Add public API documentation only for behavior
   that passes those tests. Done when the checks below pass in both integrations.

The PostgreSQL final-validation gap can be a prerequisite repair if independently
scheduled, or a commit inside #38. It is required before rename support ships.
A separate raw-action design should own provenance, phase guarantees, unsafe
permission, SQL restrictions, and replay. Any ledger or export workflow belongs
with #12's optional artifact assessment. Neither blocks typed rename implementation.

Implementation review must approve the API spelling, structural satisfaction,
fresh-table behavior, rejected chains/cycles/case-only changes, and dependency gate.
Recommendations appear above. Opaque dependencies and phased raw actions remain
deferred scope decisions.

## Proposed verification

These are future tests, not results from this documentation change.

| Layer and existing location                                                                        | Behavioral evidence                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/ddl/migrationPlan.test.ts` and `tests/unit/types/migrationPlan.test.ts`                | Step shape, fixed phase, profile behavior, canonical order under permutations, projected local/inbound dependency members, full conflict matrix, supported residual alterations, unchanged behavior without intent.                                                                                                                                     |
| `tests/unit/migrate.test.ts` and `tests/unit/ddl/migrateAdapter.test.ts`                           | Public `db.migrate().renameColumn(...).plan()/dryRun()/execute()`, read-only previews, snapshots of intent, redacted values, permission independence of planning, no permission bypass for residual drops.                                                                                                                                              |
| `tests/unit/ddl/migrationLowering.test.ts`                                                         | Complete lowering rejects unknown dependencies, profile mismatch, and unsupported later steps before any rename. SQLite residual rebuild copies from renamed addresses.                                                                                                                                                                                 |
| `tests/unit/migrationExecution.test.ts` and `tests/unit/dialects/migrationCoordinationContract.ts` | Pinned session, repeatable preparation with no effects, required relation locks/deadline, cancellation, final validation before commit, action provenance, rollback/commit/unlock/release failures, original defects and stacks.                                                                                                                        |
| `tests/integration/postgres/postgres.migration.test.ts` and `postgres.coordination.test.ts`        | Seed distinct Unicode/null/ordinary values under `displayName`, rename through public migration, read the same values under `fullName`, inspect native columns and key/index/FK identities. Repeat with and without retained context, require empty plan and no rename DDL. Test lock contention and rollback of a rename after a forced later failure. |
| `tests/integration/sqlite/sqlite.migration.test.ts`                                                | Same public value-preservation/repeat/conflict scenarios on native SQLite. Cover primary/unique keys, composite indexes, inbound/self FKs, rename followed by supported rebuild, FK/integrity checks, and policy restoration.                                                                                                                           |
| Both native suites                                                                                 | Generated dependency names remain historical and converge, authored names retain meaning, names with quotes/dots and dialect case rules work, fresh databases create normally, both/neither-column conflicts preserve all data, opaque/ambiguous dependencies fail safely, and dry-run performs no DDL/data changes.                                    |

Use native supported-dependency fixtures and separate rejected view/trigger,
expression-index, partition, incomplete-coverage, and unmanaged-target fixtures.
Do not mock native rename behavior as proof of preservation. Inject acknowledgment
and cleanup failures at existing driver/session seams where real network uncertainty
cannot be reproduced deterministically. Verify both retained diagnostics and the
observable database state through a fresh session.

Future implementation checks, taken from package scripts:

```sh
pnpm test:unit
pnpm test:integration:postgres
pnpm test:integration:sqlite
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm build
```

PostgreSQL needs the existing integration service and `POSTGRESQL_URL` setup.
This investigation used static repository inspection and official database docs.
It ran no new native rename experiment and makes no feature-completion claim.
