# ADR 0003: Expected Errors and Defects

- Status: Accepted
- Date: 2026-10-13
- Relates to: ADR 0002 (Structured Migration Plan Targets)

## Context

Error boundaries must distinguish failures callers can handle from implementation defects.
Wrapping every thrown value as a query or migration failure loses the identity and stack of
unexpected failures, and can make a programming error look like a supported capability
limitation.

## Decision

An expected error is a recognized, tagged failure with documented meaning and fields that
let a caller choose an action. `QueryError` and `MigrationError` are public expected-error
types. A SQLite migration capability issue is emitted only from the private tagged
`SqliteMigrationCapabilityError`; its code is one of the public capability issue codes.
Boundary code recognizes only the error types it owns. It must rethrow every other thrown
value unchanged unless an execution boundary must report the migration stage and database
outcome, or secondary cleanup failures require a diagnostic envelope.

A defect is an `InvariantError` or any thrown value not recognized as an expected error at
that boundary. Defects are never converted into capability issues. Query result mapping is
outside executor error handling, so mapping defects reach the caller unchanged.

Migration preview and planning preserve unrecognized defects by identity and stack when
cleanup succeeds. A
migration execution boundary may need to report its stage, outcome, action, and cleanup
evidence. In that case it throws `MigrationError` with `defect: true` and the original
thrown value as `cause`; the cause object and its stack are retained. Existing
`MigrationError` values remain expected errors and are never marked as defects merely
because a boundary adds stage or outcome information. Reconstructing a `MigrationError`
must preserve its defect marker and all existing diagnostic fields.

If preview session release also fails, the boundary reports a `MigrationError` with
`stage: 'sessionCleanup'`, the original primary cause, and ordered `cleanupFailures`.
Objects, frozen errors, and primitive causes follow the same rule. Cleanup evidence is
stored directly on the failure and appears in JSON, including native cause stacks.
There is no hidden error-identity side channel. Execution retains its primary migration
stage and database outcome when secondary cleanup fails.

Query and driver failures retain their public tags and actionable fields when cleanup
adds diagnostics. Public errors arriving from extension boundaries use branded guards
so multiple package copies retain the same meaning. Private errors use their own classes.
Unavailable optional migration diagnostics are omitted consistently across dialects.
Own `cause` presence remains meaningful, including explicit `null` or `undefined`.

## Consequences

- Capability issues describe known SQLite support limits, invalid targets, missing
  desired registrations, or Semantic Profile mismatches only.
- Unexpected failures do not masquerade as migration or query capabilities.
- Callers can use the migration stage and outcome while still inspecting the original
  defect and stack.
