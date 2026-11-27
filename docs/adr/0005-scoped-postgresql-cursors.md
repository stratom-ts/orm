# ADR 0005: Scoped PostgreSQL Cursors

- Status: Accepted
- Date: 2026-11-27
- Relates to: ADR 0003 (Expected Errors and Defects)

## Context

Large SELECT results need bounded client buffering and reliable session cleanup.
Callback transactions already own a pinned physical session and serialize SQL.
Holding a queue slot across application callbacks or iterator yields would prevent
other queries on the same transaction from progressing.

## Decision

Expose lazy, single-use `batches` and scoped `withCursor` SELECT terminals over one
transaction-owned lifecycle. The dialect compiles DECLARE NO SCROLL CURSOR WITHOUT
HOLD, FETCH FORWARD and CLOSE. Query builders prepare and map each batch using the
same projection as execute. Bindings and compiled session guards apply at declaration.
No implicit transaction, raw/write terminal, or SQLite emulation is provided.

Only physical calls occupy transaction queue slots. Fetches accepted before close
are drained in call order; new fetches reject once closure begins. Scope registries
close abandoned iterators before commit or savepoint release. Rollback invalidates
handles and relies on PostgreSQL to remove cursors, preserving ancestor cursors under
normal savepoint semantics. Cursor positions do not rewind with a savepoint. Native SQL failures while cursors
are open mark the owning scope for rollback; cleanup invalidates its handles without
issuing CLOSE in PostgreSQL's failed transaction state. Savepoint rollback can then
restore the parent's transaction without poisoning it merely for the child SQL failure.

An abort listener cancels only its cursor's active physical call. Such cancellation
poisons the transaction and discards its session. Idle or queued aborts cannot cancel
another statement. Scope finalization remains the safeguard for abandoned consumers.
Mapping and callback defects retain identity, with secondary cleanup failures added
through the existing operation cleanup diagnostics. The owning scope retains failed
CLOSE evidence after handle invalidation, because async iteration can suppress an
iterator-return failure when the loop body also throws. Mapping, terminal and scope
cleanup attach that same physical failure only once.

## Consequences

Application work between batches can run queries on the same transaction. Each
cursor has a private session-unique name and independent position. A retained batch
belongs to the caller; the library performs no prefetch. The shared lifecycle can
support a future row-stream terminal without changing the two public scopes.
