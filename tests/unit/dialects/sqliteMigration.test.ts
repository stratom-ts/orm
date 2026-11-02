import { integer, nullable, number, pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import { column, createDatabase, defineTable, reference, sqliteDialect } from '@/index'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import { customConnector } from '../helpers/operationSessionFixtures'

import { createSqliteControllableProvider } from './sqliteSharedFixtures'

const Owner = defineTable(
  'owners',
  { id: pipe(number(), integer()) },
  { primaryKey: 'id' },
)

const Parent = defineTable(
  'parent',
  {
    id: pipe(
      number(),
      integer(),
      column({ generation: { kind: 'identity', mode: 'byDefault' } }),
    ),
    label: string(),
    nick: pipe(nullable(string()), column({ unique: true })),
    owner_id: nullable(reference(Owner, 'id')),
  },
  { primaryKey: 'id', indexes: [{ name: 'parent_label', columns: ['label'] }] },
)

function registerMigrationGroup1() {
  it('should not turn an unexpected SQLite lowering failure into a capability issue', async () => {
    const connector = customConnector('sqlite')
    const db = createDatabase({
      connector,
      schemas: [Parent, Owner],
      operationSessionProvider: createSqliteControllableProvider().provider,
    })

    const defect = new TypeError('lowering defect')
    const originalStack = defect.stack

    vi.spyOn(sqliteDialect.migration, 'lower').mockImplementation(() => {
      throw defect
    })

    try {
      const rejection = await db
        .migrate()
        .dryRun()
        .catch((cause: unknown) => cause)

      expect(rejection).toBe(defect)
      expect((rejection as Error).stack).toBe(originalStack)
    } finally {
      vi.restoreAllMocks()
      await db.close()
    }
  })
}

function registerMigrationGroup2() {
  it('should rethrow defects from the real SQLite lowerer without capability conversion', async () => {
    const connector = customConnector('sqlite')
    const db = createDatabase({
      connector,
      schemas: [Parent, Owner],
      operationSessionProvider: createSqliteControllableProvider().provider,
    })

    const defect = new TypeError('profile getter failed')
    const originalStack = defect.stack
    const lower = sqliteDialect.migration.lower.bind(sqliteDialect.migration)
    vi.spyOn(sqliteDialect.migration, 'lower').mockImplementation((planned, expected) => {
      const injected = new Proxy(planned, {
        get(target, property, receiver) {
          if (property === 'profile') throw defect

          return Reflect.get(target, property, receiver) as unknown
        },
      })

      return lower(injected, expected)
    })

    try {
      const rejection = await db
        .migrate()
        .dryRun()
        .catch((cause: unknown) => cause)

      expect(rejection).toBe(defect)
      expect((rejection as Error).stack).toBe(originalStack)
    } finally {
      vi.restoreAllMocks()
      await db.close()
    }
  })
}

function registerMigrationGroup3() {
  it('should suppress the whole SQLite Migration Program when one table name is reserved', async () => {
    const Valid = defineTable(
      'aaa_valid',
      { id: pipe(number(), integer()) },
      { primaryKey: 'id' },
    )

    const Reserved = defineTable(
      'sqlite_reserved',
      { id: pipe(number(), integer()) },
      { primaryKey: 'id' },
    )

    const tables = [Valid, Reserved]
    const ownership: MigrationOwnershipDeclaration[] = [
      ...tables.map((relation) => ({
        kind: 'relation' as const,
        relation,
        shape: 'additive' as const,
      })),
    ]

    const controls = createSqliteControllableProvider()
    const session = await controls.provider.open()
    try {
      const catalog = await sqliteDialect.catalog.introspectCatalog(
        { execute: (query) => session.query(query) },
        createCatalogRequest(tables, ownership),
      )

      const migration = planMigration(tables, catalog, sqliteDialect.migration.planning, {
        migrationOwnership: ownership,
      })

      const result = sqliteDialect.migration.lower(migration, migration.profile)

      expect(result.issues?.map((entry) => entry.message)).toContain(
        'SQLite table name "sqlite_reserved" uses reserved prefix "sqlite_"',
      )

      expect(result).not.toHaveProperty('program')

      expect(
        migration.plan.steps
          .filter((step) => step.kind === 'create_table')
          .map((step) => step.target.relation.relation.spelling),
      ).toEqual(['aaa_valid', 'sqlite_reserved'])
    } finally {
      try {
        await session.release('discard')
      } finally {
        await controls.provider.close()
      }
    }
  })
}

describe('SQLite migration', () => {
  registerMigrationGroup1()
  registerMigrationGroup2()
  registerMigrationGroup3()
})
