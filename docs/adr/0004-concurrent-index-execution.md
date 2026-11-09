# ADR 0004: Concurrent Index Execution and Recovery

- Status: Accepted
- Date: 2026-11-09
- Relates to: ADRs 0001-0003

## Context

PostgreSQL concurrent index operations cannot run inside a transaction block. They can
leave index residue on failure. A migration with transactional DDL and concurrent index
operations therefore needs explicit physical boundaries and truthful partial outcomes.
Changing semantic schema intent to select those boundaries would weaken Migration Plan
stability and mix permissions with planning.

## Decision

`concurrentIndexes()` selects a run-level PostgreSQL execution policy. It does not alter
schema metadata, Semantic Profiles or semantic Migration Plan ordering. Supported
standalone indexes on existing ordinary, non-temporary tables use concurrent creation
or removal. New-table indexes stay in the table creation transaction. Unique
constraints remain ordinary transactional operations. Unsupported targets and dialects
reject before writes, including empty programs on unsupported dialects.

A physical program with any transaction-forbidden action is non-atomic and requires
`allowPartialApplication()` before writes. One concurrent action also needs consent.
Otherwise the existing atomic path remains in use. Preview exposes the same deterministic
physical phases as execution without requiring execution consent. Parameters are redacted.

Physical dependency ordering selects ready transactional actions before ready concurrent
actions, preserving new-table creation groups. Each concurrent action forms its own
phase. Adjacent transactional actions form one transaction. One pinned session retains
session advisory ownership across commits and final validation. Guards acquire relation
locks before their phase's authoritative snapshot; no transaction or relation lock is
retained across concurrent statements. Fresh preparation at boundaries rejects changes
to the remaining approved program. External, noncooperating DDL is not excluded by this
coordination contract.

A supported, unambiguously matched desired index with explicitly invalid catalog
validity produces semantic creation intent. Its observed catalog facts remain private
lowering evidence. It does not satisfy desired state. Planning is independent of grants;
unknown, conflicting, opaque, unrelated or ambiguous evidence remains guarded. Existing
explicit/generated name rules still determine matching.

Physical recovery lowers that creation intent to concurrent DROP followed by CREATE,
with one canonical target and original semantic provenance. Only
`allowFor(exactIndexTarget, 'repairInvalidIndex')` grants recovery cleanup. Global repair
grants are rejected by types and runtime validation. Ordinary drops keep their existing
`dropIndex` permissions and `sync` policy behavior.

Stop at the first failure. Never replay a saved program, retry, repair automatically, or
compensate for committed phases. Every invocation observes and plans anew. Reuse valid
matching indexes. Success requires final desired-state convergence and valid indexes.

Errors retain acknowledged committed actions, acknowledged rolled-back actions,
uncertain outcomes, the failed action's provenance and structured recovery evidence.
A failed first concurrent action can leave residue. Missing command or commit
acknowledgment is unknown even when earlier work was acknowledged. Cleanup does not
erase known outcomes. ADR 0003 cause identity, stacks, defect markers and cleanup
evidence remain intact through envelopes and JSON.

`statementTimeoutMs` is finite and nonnegative; zero disables it and omission preserves
the configured value. It applies only to concurrent actions and is saved/restored on
the pinned session. `lockTimeoutMs` retains its existing meaning. AbortSignal cancels
the run. Uncertain command, transaction or setting state requires session disposal.

## Consequences

Callers must explicitly accept partial application and inspect failures before deciding
on recovery. PostgreSQL's invalid unique indexes can still affect application writes.
The API does not promise universally nonblocking migrations. Direct or session-pinned
connections are required; transaction pooling cannot provide this contract. No durable
migration journal or background execution service is introduced.
