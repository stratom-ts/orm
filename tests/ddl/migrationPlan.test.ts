import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogSnapshot } from '@/dialects'
import { MigrationError, column, defineTable } from '@/index'

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const Settings = defineTable(
  'settings',
  {
    id: pipe(string(), column({ type: 'integer' })),
    label: string(),
    status: pipe(string(), column({ default: 'pending' })),
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

    expect(planMigration([Users], catalog)).toEqual({ steps: [] })
  })

  it('uses PostgreSQL lowering and normalization for comparisons', () => {
    const catalog: CatalogSnapshot = {
      tables: [
        {
          schema: 'public',
          name: 'settings',
          columns: [
            { name: 'id', dataType: 'int4', isNullable: false },
            { name: 'label', dataType: 'text', isNullable: false },
            {
              name: 'status',
              dataType: 'text',
              isNullable: false,
              defaultExpression: "'pending'",
            },
          ],
        },
      ],
    }

    expect(planMigration([Settings], catalog)).toEqual({ steps: [] })
  })

  it('returns a constructive step for a missing column', () => {
    const catalog = usersCatalog([{ name: 'id', dataType: 'uuid', isNullable: false }])

    expect(planMigration([Users], catalog)).toEqual({
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

  it('returns every required destructive step without permission input', () => {
    const catalog: CatalogSnapshot = {
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
            { name: 'legacy', dataType: 'text', isNullable: true },
          ],
          indexes: [{ name: 'users_stale_idx', columns: ['email'], unique: false }],
        },
        {
          schema: 'public',
          name: 'orphan',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
        },
      ],
    }

    expect(planMigration([Users], catalog)).toEqual({
      steps: [
        {
          kind: 'drop_column',
          schema: 'public',
          table: 'users',
          column: 'legacy',
        },
        {
          kind: 'drop_index',
          schema: 'public',
          table: 'users',
          index: 'users_stale_idx',
        },
        {
          kind: 'drop_table',
          schema: 'public',
          table: 'orphan',
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

    expect(() => planMigration([Users], catalog)).toThrow(MigrationError)
    expect(() => planMigration([Users], catalog)).toThrow(
      /unsupported primary key change/i,
    )
  })
})
