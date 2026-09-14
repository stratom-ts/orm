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
Register its typed inputs in `tests/unit/dialects/dialectContractKit.ts`. Set each facet
to `supported` with its input, or `unsupported` with a reason. Declare capabilities in
the adapter input. This declaration controls which shared scenarios register. Unsupported
scenarios are omitted. They must not become skipped tests.

Register integration capabilities in
`tests/integration/support/dialectIntegrationContract.ts`. Provide readiness and a
database wrapper in the adapter. Add one shared scenario only when the Dialect supports
all capabilities that scenario needs. Add an adapter-specific scenario when PostgreSQL
has behavior that a shared contract cannot express. Keep its expected result independent
from the fixture calculation.

The PostgreSQL adapter declares all five integration capabilities. Its shared integration
suite therefore registers five scenarios. A future Dialect must declare each capability
explicitly and omit unsupported scenarios.

## Fixtures and timing

Fixtures must make behavior-critical inputs visible at the test site. Shared helpers may
build valid catalog or query records, but they must not calculate the expected result.
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

The global thresholds use the stable unit-suite baseline. Scoped thresholds protect these
ownership groups: public and schema, query, Migration Plan, Dialect selection,
operation-session, and PostgreSQL adapter code. The groups overlap the global report.
Keep each threshold at the measured baseline or higher when coverage improves. The
coverage report must not contain an unexplained uncalled exported runtime helper.

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
