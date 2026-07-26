import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogSnapshot } from '@/dialects'
import { MigrationError, column, defineTable, postgresDialect } from '@/index'

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'public' },
)

function usersCatalog(
  columns: CatalogSnapshot['tables'][number]['columns'],
): CatalogSnapshot {
  return {
    tables: [
      {
        schema: 'public',
        name: 'users',
        columns,
        primaryKey: { name: 'users_pkey', columns: ['id'] },
      },
    ],
  }
}

describe('Migration Plan construction', () => {
  it('returns no steps when the catalog matches the registered tables', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({ steps: [] })
  })

  it('returns a constructive step for a missing column', () => {
    const catalog = usersCatalog([{ name: 'id', dataType: 'uuid', isNullable: false }])

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({
      steps: [
        {
          kind: 'add_column',
          schema: 'public',
          table: 'users',
          column: 'email',
          dataType: 'text',
          notNull: true,
        },
      ],
    })
  })

  it('returns a destructive step only when it is permitted', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
      { name: 'legacy', dataType: 'text', isNullable: true },
    ])

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({ steps: [] })
    expect(
      planMigration([Users], catalog, postgresDialect, new Set(['dropColumn'])),
    ).toEqual({
      steps: [
        {
          kind: 'drop_column',
          schema: 'public',
          table: 'users',
          column: 'legacy',
        },
      ],
    })
  })

  it('throws for unsupported drift', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])
    catalog.tables[0]!.primaryKey = {
      name: 'users_pkey',
      columns: ['email'],
    }

    expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(MigrationError)
    expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(
      /unsupported primary key change/i,
    )
  })
})
