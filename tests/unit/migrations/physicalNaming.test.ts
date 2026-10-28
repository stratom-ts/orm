import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { POSTGRES_IDENTITY_POLICY } from '@/dialects/postgres/identity'
import { POSTGRES_PHYSICAL_NAMING } from '@/dialects/postgres/naming'
import { column, defineTable, postgresDialect } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import {
  createPhysicalNameRegistry,
  generatedForeignKeyName,
  generatedIndexName,
  generatedPrimaryKeyName,
  generatedUniqueName,
  physicalNameDigest,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import { InvariantError, MigrationError, SchemaError } from '@/utils/error'

import type { PostgresCatalogSnapshotFixture as CatalogSnapshot } from '../dialects/postgresCatalogFixtures'
import {
  postgresCatalogPrimaryKey as createCatalogPrimaryKey,
  planPostgresMigration as planMigration,
} from '../dialects/postgresCatalogFixtures'
import {
  SQLITE_IDENTITY_POLICY,
  SQLITE_PHYSICAL_NAMING_FIXTURE,
  TABLE_LOCAL_PHYSICAL_NAMING_FIXTURE,
} from '../helpers/dialectPolicies'

const context = {
  writableDefault: [
    { role: 'database' as const, spelling: 'app_db' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const identities = createCanonicalRelationIdentityModule({
  policy: POSTGRES_IDENTITY_POLICY,
  context,
})

const sqliteIdentities = createCanonicalRelationIdentityModule({
  policy: SQLITE_IDENTITY_POLICY,
  context: {
    writableDefault: [{ role: 'database', spelling: 'main' }],
  },
})

const emptyReservations = {
  nameReservations: [],
  constraintNameReservations: [],
}

const supportedSimple = {
  semanticCompleteness: 'supportedSimple' as const,
  isValid: true,
}

const catalogPrimaryKey = createCatalogPrimaryKey(supportedSimple)

/** Resolves a PostgreSQL fixture relation for physical-name ownership checks. */
function owner(schema: string, relation: string) {
  return identities.resolve({
    namespace: [{ role: 'schema', spelling: schema }],
    relation,
  })
}

/** Resolves a SQLite fixture relation for physical-name ownership checks. */
function sqliteOwner(database: string, relation: string) {
  return sqliteIdentities.resolve({
    namespace: [{ role: 'database', spelling: database }],
    relation,
  })
}

describe('generated physical naming', () => {
  it('should have a stable documented digest vector and always include it', () => {
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
})

describe('generated physical naming: generates fixed names for every constraint seed and referential action', () => {
  it('should generate fixed names for every constraint seed and referential action', () => {
    const users = owner('public', 'users')
    const accounts = owner('public', 'accounts')
    const omittedActions = generatedUserAccountForeignKey(
      users,
      accounts,
      undefined,
      undefined,
    )

    expect({
      primaryKey: generatedPrimaryKeyName(users, ['id'], POSTGRES_PHYSICAL_NAMING),
      unique: generatedUniqueName(users, 'email', POSTGRES_PHYSICAL_NAMING),
      omittedActions,
      explicitDefaultActions: generatedUserAccountForeignKey(
        users,
        accounts,
        'no action',
        'no action',
      ),
      deleteAction: generatedUserAccountForeignKey(users, accounts, 'cascade', undefined),
      updateAction: generatedUserAccountForeignKey(
        users,
        accounts,
        undefined,
        'restrict',
      ),
      actionForeignKey: generatedUserAccountForeignKey(
        users,
        accounts,
        'cascade',
        'restrict',
      ),
    }).toEqual({
      primaryKey: 'users_id__d7178c290e1964b2_pkey',
      unique: 'users_email__f8b9f95ed39c7e37_key',
      omittedActions: 'users_accountId__22863605b8dd132c_fkey',
      explicitDefaultActions: 'users_accountId__22863605b8dd132c_fkey',
      deleteAction: 'users_accountId__eeeb070e47c9b095_fkey',
      updateAction: 'users_accountId__146bd2862472ffdf_fkey',
      actionForeignKey: 'users_accountId__b111b074295440b0_fkey',
    })
  })
})

describe('generated physical naming: uses structured seeds and does not flatten ambiguous column tuples', () => {
  it('should use structured seeds and not flatten ambiguous column tuples', () => {
    const relation = owner('public', 'events')
    expect(
      generatedIndexName(relation, ['a_b', 'c'], false, POSTGRES_PHYSICAL_NAMING),
    ).not.toBe(
      generatedIndexName(relation, ['a', 'b_c'], false, POSTGRES_PHYSICAL_NAMING),
    )
  })
})

describe('generated physical naming: truncates only the readable UTF-8 prefix without splitting scalars', () => {
  it('should truncate only the readable UTF-8 prefix without splitting scalars', () => {
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

  it('should reject a terminal high surrogate', () => {
    expect(() =>
      validatePhysicalName('invalid\ud800', 'index name', POSTGRES_PHYSICAL_NAMING),
    ).toThrow(SchemaError)
  })

  it('should keep an impossible naming profile as an invariant defect', () => {
    expect(() =>
      generatedIndexName(owner('public', 'users'), ['id'], false, {
        ...POSTGRES_PHYSICAL_NAMING,
        maximumLength: 1,
      }),
    ).toThrow(InvariantError)
  })

  it('should measure the same Unicode spelling in bytes or scalars as configured', () => {
    const twoBytes = { ...POSTGRES_PHYSICAL_NAMING, maximumLength: 2 }
    const twoScalars = { ...SQLITE_PHYSICAL_NAMING_FIXTURE, maximumLength: 2 }

    expect(() => validatePhysicalName('éé', 'name', twoBytes)).toThrow(/2 UTF-8 bytes/)
    expect(() => validatePhysicalName('éé', 'name', twoScalars)).not.toThrow()

    expect(() => validatePhysicalName('😀😀😀', 'name', twoScalars)).toThrow(
      /2 Unicode scalars/,
    )
  })
})

describe('physical name reservations', () => {
  it('should collide equal PostgreSQL names within one schema but not across schemas', () => {
    const publicUsers = owner('public', 'users')
    const publicPosts = owner('public', 'posts')
    const auditPosts = owner('audit', 'posts')
    const registry = createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING)
    registry.reserve({
      kind: 'index',
      owner: publicUsers,
      name: 'shared_idx',
      token: 'public.users',
      description: 'public users index',
    })

    expect(() =>
      registry.reserve({
        kind: 'index',
        owner: publicPosts,
        name: 'shared_idx',
        token: 'public.posts',
        description: 'public posts index',
      }),
    ).toThrow(SchemaError)

    expect(() =>
      registry.reserve({
        kind: 'index',
        owner: auditPosts,
        name: 'shared_idx',
        token: 'audit.posts',
        description: 'audit posts index',
      }),
    ).not.toThrow()
  })
})

describe('physical name reservations: collides equal SQLite names within one database alias but not across aliases', () => {
  it('should collide equal SQLite names within one database alias but not across aliases', () => {
    const mainUsers = sqliteOwner('main', 'users')
    const mainPosts = sqliteOwner('main', 'posts')
    const archivePosts = sqliteOwner('archive', 'posts')
    const registry = createPhysicalNameRegistry(SQLITE_PHYSICAL_NAMING_FIXTURE)
    registry.reserve({
      kind: 'index',
      owner: mainUsers,
      name: 'shared_idx',
      token: 'main.users',
      description: 'main users index',
    })

    expect(() =>
      registry.reserve({
        kind: 'index',
        owner: mainPosts,
        name: 'SHARED_IDX',
        token: 'main.posts',
        description: 'main posts index',
      }),
    ).toThrow(/physical name collision/i)

    expect(() =>
      registry.reserve({
        kind: 'index',
        owner: archivePosts,
        name: 'SHARED_IDX',
        token: 'archive.posts',
        description: 'archive posts index',
      }),
    ).not.toThrow()
  })
})

describe('physical name reservations: preserves table-local naming profiles', () => {
  it('should preserve table-local naming profiles', () => {
    const publicUsers = owner('public', 'users')
    const publicPosts = owner('public', 'posts')

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
})

describe('physical name reservations: makes relation-constraint reservations idempotent and owner-scoped', () => {
  it('should make relation-constraint reservations idempotent and owner-scoped', () => {
    const users = owner('public', 'users')
    const posts = owner('public', 'posts')
    const registry = createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING)
    const usersForeignKey = {
      kind: 'foreignKey' as const,
      owner: users,
      name: 'shared_fkey',
      token: 'users.accountId',
      description: 'users account foreign key',
    }

    registry.reserve(usersForeignKey)
    expect(() => registry.reserve(usersForeignKey)).not.toThrow()

    expect(() =>
      registry.reserve({
        ...usersForeignKey,
        token: 'users.ownerId',
        description: 'users owner foreign key',
      }),
    ).toThrow(/physical name collision.*shared_fkey/i)

    expect(() =>
      registry.reserve({
        ...usersForeignKey,
        owner: posts,
        token: 'posts.accountId',
        description: 'posts account foreign key',
      }),
    ).not.toThrow()
  })
})

it('should reject explicit PostgreSQL physical names above the identifier limit', () => {
  const TooLong = defineTable(
    'too_long',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
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
  ).toThrow(MigrationError)

  expect(() =>
    planMigration(
      [TooLong],
      { namespaceContext: context, tables: [], ...emptyReservations },
      postgresDialect,
    ),
  ).toThrow(/identifier limit of 63 UTF-8 bytes/i)
})

it('should reject colliding PostgreSQL physical names in one schema', () => {
  const First = defineTable(
    'first',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      value: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    },
    { primaryKey: 'id', indexes: [{ name: 'shared_idx', columns: ['value'] }] },
  )

  const Second = defineTable(
    'second',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      value: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    },
    { primaryKey: 'id', indexes: [{ name: 'shared_idx', columns: ['value'] }] },
  )

  expect(() =>
    planMigration(
      [Second, First],
      { namespaceContext: context, tables: [], ...emptyReservations },
      postgresDialect,
    ),
  ).toThrow(MigrationError)

  expect(() =>
    planMigration(
      [Second, First],
      { namespaceContext: context, tables: [], ...emptyReservations },
      postgresDialect,
    ),
  ).toThrow(/physical name collision.*shared_idx/i)
})

describe('physical name validation and legacy adoption: adopts one legacy generated index by semantics and rejects ambiguity', () => {
  it('should adopt one legacy generated index by semantics and reject ambiguity', () => {
    const Events = defineTable(
      'events',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        createdAt: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
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
          primaryKey: catalogPrimaryKey('events'),
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
})

describe('physical name validation and legacy adoption: checks generated names against non-table PostgreSQL catalog reservations', () => {
  it('should check generated names against non-table PostgreSQL catalog reservations', () => {
    const Events = defineTable(
      'events',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        payload: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
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
})

describe('physical name validation and legacy adoption: adopts legacy constraint names by unique semantics and rejects ambiguity', () => {
  it('should adopt legacy constraint names by unique semantics and reject ambiguity', () => {
    const Accounts = defineTable(
      'accounts',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        email: pipe(
          string(),
          column({ physicalType: { postgresql: 'text' }, unique: true }),
        ),
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
          primaryKey: catalogPrimaryKey('accounts'),
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

/**
 * Generates the users-to-accounts foreign-key name with the supplied referential actions.
 *
 * @param users - Canonical users relation owning the generated foreign key.
 * @param accounts - Canonical accounts relation referenced by the generated foreign key.
 * @param onDelete - Requested foreign-key deletion action.
 * @param onUpdate - Requested foreign-key update action.
 *
 * @returns The users-to-accounts foreign-key name derived from the requested actions.
 */
function generatedUserAccountForeignKey(
  users: ReturnType<typeof owner>,
  accounts: ReturnType<typeof owner>,
  onDelete: Parameters<typeof generatedForeignKeyName>[4],
  onUpdate: Parameters<typeof generatedForeignKeyName>[5],
) {
  return generatedForeignKeyName(
    users,
    'accountId',
    accounts,
    'id',
    onDelete,
    onUpdate,
    POSTGRES_PHYSICAL_NAMING,
  )
}
