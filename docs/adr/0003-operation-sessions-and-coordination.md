# ADR 0003: Operation Sessions and Root Coordination

- Status: Accepted
- Date: 2026-08-01

## Context

db0's ordinary executor surface does not promise that separate calls use one physical
connection. Transactions, advisory locks, catalog introspection, and migration DDL need
that affinity. Serializing individual calls also permits unrelated queries to enter the
middle of a callback transaction or migration cleanup.

Migration coordination is currently a database-wide PostgreSQL advisory lock. Future
scoped coordination must coexist safely with clients that know only that legacy lock.

## Decision

Stratom uses a separate mandatory operation-session capability. A provider opens one
exclusive physical session with stable database/backend identity, serial query and run
calls, cancellation, and exactly-once reuse-or-discard release. The ordinary query
`Executor` remains unchanged and is adapted from a session internally. The db0 0.3.4
PostgreSQL provider accepts only its native pinned `pg.Client` behavior and verifies the
backend PID, current database, client stability, and clean reuse. Custom providers are
an explicit configuration choice and must declare native transaction semantics.

Each client has a FIFO root-operation coordinator. A query, callback transaction,
migration dry-run, and complete migration owns one slot from session open through
cleanup and release. Async-local operation context distinguishes forbidden root-client
reentrancy inside a callback from unrelated concurrent callers, which wait normally.
Transaction clients and nested savepoints carry the active operation token and reuse
the pinned session. Each transaction scope serializes its statements and complete child
savepoint lifecycles. Descendant callbacks must use their callback client; ancestor
client calls from those callbacks are rejected, while unrelated ancestor calls wait for
savepoint cleanup. Failed savepoint cleanup poisons the transaction and discards the
session. Closing stops admission, drains accepted operations, then closes the provider.

Migration coordination scope is the canonical PostgreSQL database identity plus an
optional validated stable `applicationId`. Without an application ID, coordination is
database-wide and legacy-compatible. During mixed-version transition, semantic lock
identity order is legacy first then new scope; release order is reversed.

## Boundary

This decision does not move PostgreSQL lock SQL, define the scoped lock hash, add finite
lock polling, change unlock outcomes, introduce a repeatable-read authoritative
snapshot, lower whole-plan actions, or add partial/unknown migration outcomes. Those
runtime changes remain in #96 and #16. Current migration SQL stays in `migrate.ts`, but
the complete sequence now executes on one operation session.

## Consequences

- Connectors that cannot prove pinned native transaction behavior fail instead of
  silently degrading safety.
- Same-client root operations cannot interleave, including cleanup and release.
- Separate clients retain separate physical sessions and database-level coordination.
- Node async context is part of client callback semantics; coordinator tokens remain
  private and are not part of the public API.
