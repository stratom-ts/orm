import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogSnapshot } from '@/dialects'
import { column, defineTable, postgresDialect } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import {
  POSTGRES_PHYSICAL_NAMING,
  SQLITE_PHYSICAL_NAMING_FIXTURE,
  TABLE_LOCAL_PHYSICAL_NAMING_FIXTURE,
  createPhysicalNameRegistry,
  generatedIndexName,
  physicalNameDigest,
  validatePhysicalName,
} from '@/migrations/physicalNaming'

const context = {
  writableDefault: [
    { role: 'database' as const, spelling: 'app_db' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}
const identities = createCanonicalRelationIdentityModule({
  adapter: 'postgresql',
  context,
})
const emptyReservations = {
  nameReservations: [],
  constraintNameReservations: [],
}
const supportedSimple = {
  semanticCompleteness: 'supportedSimple' as const,
  isValid: true,
}

function owner(schema: string, relation: string) {
  return identities.resolve({
    namespace: [{ role: 'schema', spelling: schema }],
    relation,
  })
}

describe('generated physical naming', () => {
  it('has a stable documented digest vector and always includes it', () => {
    const seed = {
      kind: 'index' as const,
      owner: owner('public', 'users'),
      columns: ['email'],
      unique: false,
    }
    expect(physicalNameDigest(seed)).toBe('5a64532c865bca5a')
    expect(
      generatedIndexName(seed.owner, seed.columns, false, POSTGRES_PHYSICAL_NAMING),
    ).toBe('users_email__5a64532c865bca5a_idx')
  })

  it('uses structured seeds and does not flatten ambiguous column tuples', () => {
    const relation = owner('public', 'events')
    expect(
      generatedIndexName(relation, ['a_b', 'c'], false, POSTGRES_PHYSICAL_NAMING),
    ).not.toBe(
      generatedIndexName(relation, ['a', 'b_c'], false, POSTGRES_PHYSICAL_NAMING),
    )
  })

  it('truncates only the readable UTF-8 prefix without splitting scalars', () => {
    const relation = owner('public', `events_${'😀'.repeat(30)}`)
    const name = generatedIndexName(
      relation,
      ['payload'],
      false,
      POSTGRES_PHYSICAL_NAMING,
    )
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63)
    expect(name).toMatch(/__[0-9a-f]{16}_idx$/)
    expect(name).not.toMatch(/[\ud800-\udbff]$/)
  })

  it('rejects a terminal high surrogate', () => {
    expect(() =>
      validatePhysicalName('invalid\ud800', 'index name', POSTGRES_PHYSICAL_NAMING),
    ).toThrow(/unpaired Unicode surrogates/)
  })

  it('uses PostgreSQL and SQLite schema-wide scopes but preserves table-local profiles', () => {
    const publicUsers = owner('public', 'users')
    const publicPosts = owner('public', 'posts')

    for (const profile of [POSTGRES_PHYSICAL_NAMING, SQLITE_PHYSICAL_NAMING_FIXTURE]) {
      const registry = createPhysicalNameRegistry(profile)
      registry.reserve({
        kind: 'index',
        owner: publicUsers,
        name: 'shared_idx',
        token: 'users',
        description: 'users index',
      })
      expect(() =>
        registry.reserve({
          kind: 'index',
          owner: publicPosts,
          name: profile.id === 'sqlite-fixture' ? 'SHARED_IDX' : 'shared_idx',
          token: 'posts',
          description: 'posts index',
        }),
      ).toThrow(/physical name collision/i)
    }

    const local = createPhysicalNameRegistry(TABLE_LOCAL_PHYSICAL_NAMING_FIXTURE)
    local.reserve({
      kind: 'index',
      owner: publicUsers,
      name: 'same_idx',
      token: 'users',
      description: 'users index',
    })
    expect(() =>
      local.reserve({
        kind: 'index',
        owner: publicPosts,
        name: 'SAME_IDX',
        token: 'posts',
        description: 'posts index',
      }),
    ).not.toThrow()
  })

  it('rejects explicit PostgreSQL overlength and schema-wide collisions', () => {
    const TooLong = defineTable(
      'too_long',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        email: pipe(string(), column({ type: 'text' })),
      },
      {
        primaryKey: 'id',
        indexes: [{ name: 'x'.repeat(64), columns: ['email'] }],
      },
    )
    expect(() =>
      planMigration(
        [TooLong],
        { namespaceContext: context, tables: [], ...emptyReservations },
        postgresDialect,
      ),
    ).toThrow(/identifier limit of 63 UTF-8 bytes/i)

    const First = defineTable(
      'first',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        value: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', indexes: [{ name: 'shared_idx', columns: ['value'] }] },
    )
    const Second = defineTable(
      'second',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        value: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', indexes: [{ name: 'shared_idx', columns: ['value'] }] },
    )
    expect(() =>
      planMigration(
        [Second, First],
        { namespaceContext: context, tables: [], ...emptyReservations },
        postgresDialect,
      ),
    ).toThrow(/physical name collision.*shared_idx/i)
  })

  it('adopts one legacy generated index by semantics and rejects ambiguity', () => {
    const Events = defineTable(
      'events',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        createdAt: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['createdAt'] }] },
    )
    const catalog: CatalogSnapshot = {
      namespaceContext: context,
      ...emptyReservations,
      tables: [
        {
          schema: 'public',
          name: 'events',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'createdAt', dataType: 'text', isNullable: false },
          ],
          indexes: [
            {
              name: 'events_createdAt_idx',
              columns: ['createdAt'],
              unique: false,
              ...supportedSimple,
            },
          ],
        },
      ],
    }
    expect(planMigration([Events], catalog, postgresDialect)).toEqual({ steps: [] })

    catalog.tables[0]!.indexes!.push({
      name: 'legacy_duplicate_idx',
      columns: ['createdAt'],
      unique: false,
      ...supportedSimple,
    })
    expect(() => planMigration([Events], catalog, postgresDialect)).toThrow(
      /ambiguous index semantic match/i,
    )
  })

  it('checks generated names against non-table PostgreSQL catalog reservations', () => {
    const Events = defineTable(
      'events',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        payload: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['payload'] }] },
    )
    const generated = generatedIndexName(
      owner('public', 'events'),
      ['payload'],
      false,
      POSTGRES_PHYSICAL_NAMING,
    )
    expect(() =>
      planMigration(
        [Events],
        {
          namespaceContext: context,
          tables: [],
          nameReservations: [{ schema: 'public', name: generated }],
          constraintNameReservations: [],
        },
        postgresDialect,
      ),
    ).toThrow(/physical name collision/i)
  })

  it('adopts legacy constraint names by unique semantics and rejects ambiguity', () => {
    const Accounts = defineTable(
      'accounts',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        email: pipe(string(), column({ type: 'text', unique: true })),
      },
      { primaryKey: 'id' },
    )
    const catalog: CatalogSnapshot = {
      namespaceContext: context,
      ...emptyReservations,
      tables: [
        {
          schema: 'public',
          name: 'accounts',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
          uniqueConstraints: [
            {
              name: 'legacy_email_key',
              columns: ['email'],
              ...supportedSimple,
            },
          ],
        },
      ],
    }
    expect(planMigration([Accounts], catalog, postgresDialect)).toEqual({ steps: [] })

    catalog.tables[0]!.uniqueConstraints!.push({
      name: 'another_email_key',
      columns: ['email'],
      ...supportedSimple,
    })
    expect(() => planMigration([Accounts], catalog, postgresDialect)).toThrow(
      /ambiguous unique constraint semantic match/i,
    )
  })
})
