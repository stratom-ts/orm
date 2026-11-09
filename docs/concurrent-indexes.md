# Concurrent index execution and recovery

PostgreSQL concurrent indexes are an opt-in execution policy for one migration run.
They are independent of schema declarations and the semantic Migration Plan.

```typescript
const migration = db.migrate().concurrentIndexes().allowPartialApplication()
const preview = await migration.dryRun()
await migration.execute({ statementTimeoutMs: 3_600_000, lockTimeoutMs: 5_000 })
```

## Scope and consent

Supported standalone index creates and drops on existing ordinary PostgreSQL tables
use `CONCURRENTLY` outside transaction blocks. Unique standalone indexes are included.
Indexes on newly created tables use ordinary creation in that table's creation
transaction. Unique constraints keep their ordinary transactional implementation.

Concurrent mode does not guarantee uninterrupted application writes for the complete
migration. Other operations can acquire blocking locks. Partitioned and temporary
concurrent targets, constraint-backed indexes, opaque semantics, unsupported definitions
and unsupported dialects reject before writes. There is no blocking fallback, `CASCADE`,
or `IF NOT EXISTS` shortcut. SQLite rejects concurrent mode even for an empty program;
`plan()` still returns the same semantic intent.

`allowPartialApplication()` is required before any migration writes when the physical
program contains a transaction-forbidden action. This includes a single concurrent
index action. Consent alone does not split an otherwise atomic migration. Existing
calls keep migration-wide atomicity. Preview can display a non-atomic program without
consent or destructive execution grants.

## Preview and execution phases

The physical preview exposes `atomicity`, ordered `actions`, and, for mixed programs,
`phases`. Each phase lists original `actionIndexes` and a transaction requirement.
A `required` phase is one transaction with a commit boundary. A `forbidden` phase is
one action outside a transaction. Each action retains its original
`sourceStepIndexes`; concurrent actions also retain their structured `target`.
Repairs expose separate `repair: 'drop'` and `repair: 'create'` actions with the same
target and source step. Bound parameters remain redacted. SQL literals remain verbatim.

Physical ordering respects dependencies, including referenced unique indexes and
indexes that must be removed before columns. Ready transactional actions precede
ready concurrent actions so new-table indexes stay with table creation. Adjacent
transactional actions form one group; concurrent statements execute sequentially.

One pinned operation session owns session advisory locks across all commits and
through final validation. Use a direct connection or session pooling that preserves
this session identity; transaction pooling is unsuitable. Relation locks and guards
belong only to their transactional phase. The runtime commits before concurrent SQL,
without retaining relation locks or repeatable-read snapshots across builds.

Every invocation observes the catalog and creates a fresh Migration Plan. Preparation,
permissions, Semantic Profile checks and complete lowering precede writes. At phase
boundaries the runtime observes again and compares the remaining physical program
with the approved program. It stops on drift rather than adding new work. Advisory
coordination covers cooperating migrations, not unrelated external DDL.

## Failure and recovery

`MigrationError.completedActions` lists actions whose commits or concurrent commands
were acknowledged. `rolledBackActions` lists attempted actions in a phase whose rollback
was acknowledged. Each entry retains its original action index, source steps, and
available structured target. The failed action still uses `actionIndex` and
`sourceStepIndexes`.

The outcome distinguishes `unchanged`, `rolledBack`, `partial`, `applied`, and `unknown`.
A failed concurrent command can leave effects even when no earlier action completed.
Such a failure reports `partial` when PostgreSQL acknowledged command failure;
connection or acknowledgment loss reports `unknown`. Earlier acknowledged work remains
listed in either case. Cleanup failure after all actions were acknowledged does not
erase the known applied effect. Final validation failure after commits does not imply
global rollback.

Concurrent failure includes `recovery` with the exact index target, operation,
`status`, `requires: 'inspectAndReplan'`, and the dedicated repair permission name.
`observedValidity` appears only when inspection establishes `valid`, `invalid`, or
`absent`. Without that observation, no absence or validity is claimed. Unknown outcomes
are not safe for blind retry. Defect cause identity, stacks, and ordered cleanup
failures survive diagnostic envelopes and JSON.

Inspect the catalog and fix the underlying cause first. PostgreSQL can leave an invalid
index after a failed concurrent build. A failed unique build can continue enforcing
uniqueness. Use the desired index target from a freshly observed plan or recovery
evidence to authorize a deliberate repair:

```typescript
const plan = await migration.plan()
const step = plan.steps.find((candidate) => candidate.kind === 'create_index')
if (step) {
  migration.allowFor(step.target, 'repairInvalidIndex')
  await migration.dryRun()
  await migration.execute()
}
```

Planning proposes creation only for an unambiguous, supported, known-invalid desired
match. Invalid objects do not satisfy desired state. Authored names retain their exact
meaning; generated names use supported semantic matching. Unknown validity, unrelated
invalid indexes, conflicting definitions and ambiguous matches remain guarded. Planning
never depends on repair grants. Physical recovery uses concurrent DROP followed by
CREATE and requires the exact index grant before any writes. Global repair permission,
global or target `dropIndex`, and `policy('sync')` do not authorize recovery cleanup.
Valid matching indexes are reused on subsequent invocations.

There are no automatic retries, repairs, compensating rollbacks or persisted programs.
Success requires final convergence with valid matching indexes.

## Timeouts and cancellation

`statementTimeoutMs` accepts finite nonnegative numbers. It applies separately to each
concurrent statement; zero disables the statement timeout. Omission preserves the
session's configured setting. The runtime saves and restores the previous session
setting with parameterized SQL. It does not change settings for ordinary atomic work.
`lockTimeoutMs` retains its coordination and guarded relation-lock deadline meaning.
`AbortSignal` cancels the whole run, not just one phase.

After timeout or cancellation, inspect possible index residue. Cancellation drains
in-flight work and discards an uncertain session. Lost command or commit acknowledgment,
or uncertain settings restoration, also prevents session reuse. Secondary cleanup
failures cannot replace the primary error or erase acknowledged progress.

PostgreSQL's [CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html),
[DROP INDEX](https://www.postgresql.org/docs/current/sql-dropindex.html), and
[advisory lock](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)
documentation describes the database mechanics behind these restrictions.
