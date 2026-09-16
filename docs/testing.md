# Testing guide

This guide maps each behavior family to its owning test seam. Keep a test at the
narrowest seam that can show the behavior.

## Test locations

| Behavior                          | Test location                                                                                                           | Test level  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- |
| Public client and schema behavior | `tests/unit/client*.test.ts`, `tests/unit/migrate.test.ts`, `tests/unit/defineTable.test.ts`, and `tests/unit/schemas/` | Unit        |
| Shared Dialect contracts          | `tests/unit/dialects/dialectContractKit.ts` and `tests/unit/dialects/*Contract.test.ts`                                 | Unit        |
| Pure rules and value mapping      | `tests/unit/migrations/`, `tests/unit/ddl/`, `tests/unit/query/`, and focused utility files                             | Unit        |
| PostgreSQL adapter behavior       | `tests/unit/dialects/postgres*.test.ts` and `tests/unit/postgres*.test.ts`                                              | Unit        |
| Type contracts                    | `tests/unit/types/` and compile-time checks in the owning unit suite                                                    | Unit        |
| PostgreSQL database behavior      | `tests/integration/`                                                                                                    | Integration |

The public tests use exports from `src/index.ts` or the public client path. Shared
contracts test behavior that every Dialect must provide. Pure tests use deterministic
inputs and do not open a database. Adapter tests cover PostgreSQL SQL, mapping, schema,
catalog, operation-session, and migration seams. Integration tests check the same public
behavior against PostgreSQL.

Large suites must own one seam and one behavior family. Keep the public migration path
in `tests/unit/migrate.test.ts` and select behavior in `tests/unit/query/select.test.ts`.
Split an adapter suite by behavior, not by line count. Put catalog decoding in the
PostgreSQL catalog suite. Do not copy a case when another test already protects the same
risk at an equal or better seam.

## Dialect contracts

Add a new Dialect to the shared unit contracts before adding adapter-specific cases.
Register it once with `registerDialectContractMember()`. Pass the member name, one complete
capability declaration, and one descriptor for every named shard. A descriptor requires every facet
its shard owns and rejects foreign facets. The aggregate rejects an omitted capability,
an omitted whole shard, or an incomplete shard before it registers scenarios. Set each
facet to `supported`, or `unsupported` with a non-blank reason. Unsupported scenarios are
omitted; they must not become skipped tests. Shard descriptors can be imported from
focused fixture modules, but those modules do not register contracts themselves.

Register integration capabilities in
`tests/integration/support/dialectIntegrationContract.ts`. Provide readiness and a
database wrapper in the adapter. Add one shared scenario only when the Dialect supports
all capabilities that scenario needs. Add an adapter-specific scenario when PostgreSQL
has behavior that a shared contract cannot express. Keep its expected result independent
from the fixture calculation.

The PostgreSQL adapter declares all five integration capabilities. Its shared integration
suite therefore registers five scenarios. A future Dialect must declare each capability
explicitly; unsupported capability reasons must be non-blank, and their database scenarios
remain unregistered.

## Fixtures and timing

Fixtures must make behavior-critical inputs visible at the test site. Shared helpers may
build valid catalog or query records, but they must not calculate the expected result.
Lifecycle fixtures supply an independent expected Migration Plan and an independent
post-migration query, catalog, or equivalent physical-state observation. They do not
discard dry-run output or treat an adapter-reported `applied` outcome as proof of change.
Keep expected SQL, plans, errors, and catalog facts in the test that owns the behavior.

Do not use a fixed sleep to control correctness. Use a deferred promise, a gate, or a
microtask to control completion. Use fake timers only for a deadline-specific test.
Safety timeouts and PostgreSQL readiness polling may remain because they bound failure or
wait for an external service. They must not decide whether the behavior succeeds.

Preserve cleanup in every test. Close public clients, release sessions, and remove test
schemas through the existing harness. A test must not depend on a previous test's order,
retry, or process state. The suite contains no skipped, pending, or retry-dependent tests.

## Coverage safeguards

Coverage includes `src/**/*.ts`. The configuration excludes only barrel modules and
type-only modules. Barrel modules only re-export symbols. Type-only modules emit no
runtime behavior. The guide records these reasons so a runtime assembly file cannot hide
uncalled behavior. Mixed runtime files, including `src/dialects/postgres/index.ts`, stay
in the report.

The global thresholds protect against large coverage losses without setting a threshold
for each behavior group. Use the report to check public and schema, query, Migration Plan,
Dialect selection, operation-session, and PostgreSQL adapter code. The coverage report
must not contain an unexplained uncalled exported runtime helper.

The global thresholds are 91% statements, 84% branches, 96% functions, and 92% lines.
They match the rounded stable baseline for the current suite. Keep these thresholds global;
do not add separate thresholds for individual behavior groups.

## Commands

Run the unit suite for public, contract, pure-rule, and adapter tests:

```bash
pnpm test:unit
```

Run the PostgreSQL suite with `POSTGRESQL_URL` set to the test database:

```bash
pnpm test:integration
```

Run both suites:

```bash
pnpm test
```

Run unit coverage and all repository checks:

```bash
pnpm test:coverage
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm build
git diff --check
```
