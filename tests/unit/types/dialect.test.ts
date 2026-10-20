import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createDb0NodeSqliteOperationSessionProvider,
  createDb0PostgresOperationSessionProvider,
  postgresDialect,
  resolveDialect,
  sqliteDialect,
} from '@/index'
import type {
  CreateDatabaseConfig,
  Dialect,
  DialectIdentity,
  DialectMigrationAdapter,
  DialectNaming,
  DialectOperations,
  DialectQuery,
  DialectSchema,
  OperationCommand,
} from '@/index'
import type {
  CanonicalRelationIdentity,
  NamespaceContext,
} from '@/migrations/canonicalRelationIdentity'

describe('public dialect member contract', () => {
  it('should expose every cohesive facet and keep the database config connector-selected', () => {
    expectTypeOf<Dialect['identity']>().toEqualTypeOf<DialectIdentity>()
    expectTypeOf<Dialect['naming']>().toEqualTypeOf<DialectNaming>()
    expectTypeOf<Dialect['schema']>().toEqualTypeOf<DialectSchema>()
    expectTypeOf<Dialect['query']>().toEqualTypeOf<DialectQuery>()
    expectTypeOf<Dialect['operations']>().toEqualTypeOf<DialectOperations>()
    expectTypeOf<Dialect['migration']>().toEqualTypeOf<DialectMigrationAdapter>()

    expectTypeOf<
      Parameters<DialectOperations['compile']>[0]
    >().toEqualTypeOf<OperationCommand>()

    expectTypeOf<DialectNaming>().not.toHaveProperty('comparisonKey')
    expectTypeOf<DialectNaming>().not.toHaveProperty('maximumLength')
    expectTypeOf<DialectNaming>().not.toHaveProperty('scope')
    expectTypeOf<CreateDatabaseConfig>().not.toHaveProperty('dialect')
  })

  it('should expose production behavior only through cohesive facets', () => {
    expectTypeOf<Dialect>().not.toHaveProperty('relationIdentity')
    expectTypeOf<Dialect>().not.toHaveProperty('lowerDesiredSchema')
    expectTypeOf<Dialect>().not.toHaveProperty('inferColumnType')
    expectTypeOf<Dialect>().not.toHaveProperty('normalizeDataType')
    expectTypeOf<Dialect>().not.toHaveProperty('normalizeDefaultValue')
    expectTypeOf<Dialect>().not.toHaveProperty('compile')
    expectTypeOf<Dialect>().not.toHaveProperty('mapResultValue')
    expectTypeOf<Dialect>().not.toHaveProperty('mapParamValue')

    expect(postgresDialect.operations.createSessionProvider).toBe(
      createDb0PostgresOperationSessionProvider,
    )

    expect(sqliteDialect.operations.createSessionProvider).toBe(
      createDb0NodeSqliteOperationSessionProvider,
    )

    for (const dialect of [postgresDialect, sqliteDialect]) {
      expect(dialect.catalog).toBeDefined()
      expect(dialect.migration.planning.identity).toBe(dialect.identity)
      expect(dialect.migration.planning.naming).toBe(dialect.naming)
      expect(dialect.migration.planning.schema).toBe(dialect.schema)
      expect(dialect.migration.catalog).toBe(dialect.catalog)
    }
  })
})

describe('public dialect member contract: binds PostgreSQL identity and naming semantics behind the facets', () => {
  it('should bind PostgreSQL identity and naming semantics behind the facets', () => {
    const context: NamespaceContext = {
      writableDefault: [
        { role: 'database', spelling: 'app' },
        { role: 'schema', spelling: 'public' },
      ],
    }

    const identity = postgresDialect.identity.create({ context }).resolve({
      relation: 'users',
    })

    expect(identity.namespace.map((segment) => segment.identifier.spelling)).toEqual([
      'app',
      'public',
    ])

    const seed = {
      kind: 'index' as const,
      owner: identity,
      columns: ['email'],
      unique: false,
    }

    expect(postgresDialect.naming.generate(seed)).toBe(
      'users_email__75d8a7c1b67c60f1_idx',
    )

    expect(() => postgresDialect.naming.validate('invalid\ud800', 'index name')).toThrow(
      /unpaired Unicode surrogates/,
    )

    assertPhysicalRegistryCollision(identity)
  })
})

describe('public dialect member contract: resolves every production dialect member', () => {
  it('should resolve every production dialect member', () => {
    expect(resolveDialect('postgresql')).toBe(postgresDialect)
    expect(resolveDialect('sqlite')).toBe(sqliteDialect)
  })
})

/**
 * Checks rejection when different owners claim the same physical index name.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 */
function assertPhysicalRegistryCollision(identity: CanonicalRelationIdentity) {
  const registry = postgresDialect.naming.createRegistry()
  registry.reserve({
    kind: 'index',
    owner: identity,
    name: 'users_email_idx',
    token: 'users-email',
    description: 'users email index',
  })

  expect(() =>
    registry.reserve({
      kind: 'index',
      owner: identity,
      name: 'users_email_idx',
      token: 'different-token',
      description: 'another users email index',
    }),
  ).toThrow(/physical name collision/i)
}
