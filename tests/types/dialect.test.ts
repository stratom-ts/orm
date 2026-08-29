import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createDb0PostgresqlOperationSessionProvider,
  postgresDialect,
  resolveDialect,
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
} from '@/index'
import type { NamespaceContext } from '@/migrations/canonicalRelationIdentity'

describe('public dialect member contract', () => {
  it('exposes every cohesive facet and keeps the database config connector-selected', () => {
    expectTypeOf<Dialect['identity']>().toEqualTypeOf<DialectIdentity>()
    expectTypeOf<Dialect['naming']>().toEqualTypeOf<DialectNaming>()
    expectTypeOf<Dialect['schema']>().toEqualTypeOf<DialectSchema>()
    expectTypeOf<Dialect['query']>().toEqualTypeOf<DialectQuery>()
    expectTypeOf<Dialect['operations']>().toEqualTypeOf<DialectOperations>()
    expectTypeOf<Dialect['migration']>().toEqualTypeOf<DialectMigrationAdapter>()
    expectTypeOf<DialectNaming>().not.toHaveProperty('comparisonKey')
    expectTypeOf<DialectNaming>().not.toHaveProperty('maximumLength')
    expectTypeOf<DialectNaming>().not.toHaveProperty('scope')
    expectTypeOf<CreateDatabaseConfig>().not.toHaveProperty('dialect')
  })

  it('exposes PostgreSQL behavior through reference-identical transitional aliases', () => {
    expect(postgresDialect.relationIdentity).toBe('postgresql')
    expect(postgresDialect.schema.lowerDesiredSchema).toBe(
      postgresDialect.lowerDesiredSchema,
    )
    expect(postgresDialect.schema.inferColumnType).toBe(postgresDialect.inferColumnType)
    expect(postgresDialect.schema.normalizeDataType).toBe(
      postgresDialect.normalizeDataType,
    )
    expect(postgresDialect.schema.normalizeDefaultValue).toBe(
      postgresDialect.normalizeDefaultValue,
    )
    expect(postgresDialect.query.compile).toBe(postgresDialect.compile)
    expect(postgresDialect.query.mapResultValue).toBe(postgresDialect.mapResultValue)
    expect(postgresDialect.query.mapParamValue).toBe(postgresDialect.mapParamValue)
    expect(postgresDialect.operations.createSessionProvider).toBe(
      createDb0PostgresqlOperationSessionProvider,
    )
    expect(postgresDialect.catalog).toBeDefined()
    expect(postgresDialect.migration.planning.identity).toBe(postgresDialect.identity)
    expect(postgresDialect.migration.planning.naming).toBe(postgresDialect.naming)
    expect(postgresDialect.migration.planning.schema).toBe(postgresDialect.schema)
    expect(postgresDialect.migration.catalog).toBe(postgresDialect.catalog)
  })

  it('binds PostgreSQL identity and naming semantics behind the facets', () => {
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
  })

  it('resolves the complete PostgreSQL dialect member', () => {
    expect(resolveDialect('postgresql')).toBe(postgresDialect)
  })
})
