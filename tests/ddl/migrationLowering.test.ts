import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { lowerMigrationPlan } from '@/ddl/migrate'
import type { MigrationSemanticProfile, PlannedMigration } from '@/ddl/migrationPlan'
import { planMigration as planMigrationWithContext } from '@/ddl/migrationPlan'
import { MigrationError, column, defineTable, postgresDialect, reference } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import type { LegacyCatalogSnapshotFixture as CatalogSnapshot } from '../helpers/catalog'
import { completePostgresCatalog } from '../helpers/catalog'

const namespaceContext = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    email: pipe(string(), column({ type: 'text', unique: true })),
  },
  { primaryKey: 'id', schema: 'public', indexes: [{ columns: ['email'] }] },
)

const Posts = defineTable(
  'posts',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    authorId: reference(Users, 'id', { onDelete: 'cascade' }),
  },
  { primaryKey: 'id', schema: 'public' },
)

function emptyCatalog(): CatalogSnapshot {
  return {
    namespaceContext,
    tables: [],
    nameReservations: [],
    constraintNameReservations: [],
  }
}

function plan(catalog: CatalogSnapshot = emptyCatalog()): PlannedMigration {
  const schemas = [Users, Posts]
  return planMigrationWithContext(
    schemas,
    completePostgresCatalog(catalog, createCatalogRequest(schemas, [])),
    postgresDialect,
  )
}

const expectedProfile: MigrationSemanticProfile = {
  identityAdapter: 'postgresql',
  namespaceContext,
}

function lower(planned: PlannedMigration, profile = expectedProfile) {
  return lowerMigrationPlan(planned, postgresDialect, profile)
}

describe('whole-plan lowering', () => {
  it('lowers every semantic step to one PostgreSQL statement AST', () => {
    const planned = plan()
    const lowered = lower(planned)

    expect(lowered.map(({ ast }) => ast.kind)).toEqual([
      'create_table',
      'create_table',
      'create_index',
      'add_foreign_key',
    ])
    expect(lowered.map(({ step }) => step.kind)).toEqual([
      'create_table',
      'create_table',
      'create_index',
      'add_foreign_key',
    ])
  })

  it('resolves target-only create steps from the exact registered desired table', () => {
    const planned = plan()
    const [firstCreate] = lower(planned)

    expect(firstCreate?.ast).toMatchObject({
      kind: 'create_table',
      schema: 'public',
      table: 'posts',
      primaryKey: ['id'],
    })
    // Target-only creation never carries its references; they stay separate steps.
    const created = firstCreate?.ast
    if (created?.kind !== 'create_table') throw new Error('Expected a create_table AST')
    expect(created.columns.every((column) => column.references === undefined)).toBe(true)
  })

  it('projects structured foreign-key references into qualified statement fields', () => {
    const planned = plan()
    const foreignKey = lower(planned).at(-1)

    expect(foreignKey?.ast).toMatchObject({
      kind: 'add_foreign_key',
      schema: 'public',
      table: 'posts',
      column: 'authorId',
      references: {
        schema: 'public',
        table: 'users',
        column: 'id',
        onDelete: 'cascade',
      },
    })
  })

  it('rejects a plan whose identity adapter does not match the executing run', () => {
    const planned = plan()
    const sqliteLike = { ...postgresDialect, relationIdentity: 'sqlite' as const }
    const lowerAsSqlite = () =>
      lowerMigrationPlan(planned, sqliteLike, {
        ...expectedProfile,
        identityAdapter: 'sqlite',
      })

    expect(lowerAsSqlite).toThrow(MigrationError)
    expect(lowerAsSqlite).toThrow(/identity adapter 'postgresql'/i)
  })

  it('rejects a plan resolved under a different writable namespace context', () => {
    const planned = plan()

    expect(() =>
      lower(planned, {
        ...expectedProfile,
        namespaceContext: {
          writableDefault: [
            { role: 'database', spelling: 'production' },
            { role: 'schema', spelling: 'public' },
          ],
        },
      }),
    ).toThrow(/writable namespace context does not match/i)
  })

  it('rejects an executing profile that disagrees with its own dialect', () => {
    const planned = plan()

    expect(() =>
      lower(planned, { ...expectedProfile, identityAdapter: 'sqlite' }),
    ).toThrow(/executing profile adapter 'sqlite' does not match dialect adapter/i)
  })

  it('treats an empty registration default as none', () => {
    const planned = plan()

    expect(() =>
      lower(planned, { ...expectedProfile, registrationDefault: [] }),
    ).not.toThrow()
  })

  it('accepts equivalent spellings of one resolved registration default', () => {
    const schemas = [Users, Posts]
    const registrationDefault = [{ role: 'schema' as const, spelling: 'public' }]
    const planned = planMigrationWithContext(
      schemas,
      completePostgresCatalog(
        emptyCatalog(),
        createCatalogRequest(schemas, [], registrationDefault),
      ),
      postgresDialect,
      { registrationDefault },
    )

    expect(() =>
      lower(planned, {
        ...expectedProfile,
        registrationDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'public' },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects a plan resolved under a different registration default', () => {
    const planned = plan()

    expect(() =>
      lower(planned, {
        ...expectedProfile,
        registrationDefault: [{ role: 'schema', spelling: 'tenant' }],
      }),
    ).toThrow(/registration default does not match/i)
  })

  it('rejects a target-only create step with no registered desired table', () => {
    const planned = plan()
    const withoutRegistrations: PlannedMigration = {
      ...planned,
      desiredTables: planned.identities.createRegistry(),
    }

    expect(() => lower(withoutRegistrations)).toThrow(/lowered CreateTableAst not found/i)
  })
})
