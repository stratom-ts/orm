import { nullable, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogSnapshot } from '@/dialects'
import { MigrationError, column, defineTable, reference } from '@/index'

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

const Accounts = defineTable(
  'accounts',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    addedReference: reference(Users, 'id'),
    addedText: pipe(string(), column({ type: 'text' })),
    changedType: pipe(string(), column({ type: 'text' })),
    madeNullable: nullable(pipe(string(), column({ type: 'text' }))),
    madeRequired: pipe(string(), column({ type: 'text' })),
    indexSecond: pipe(string(), column({ type: 'text' })),
    indexFirst: pipe(string(), column({ type: 'text' })),
  },
  {
    primaryKey: 'id',
    indexes: [
      {
        name: 'accounts_ordered_idx',
        columns: ['indexSecond', 'indexFirst'],
      },
    ],
  },
)

const Comments = defineTable(
  'comments',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    userId: reference(Users, 'id'),
  },
  { primaryKey: 'id' },
)

const AuditEvents = defineTable(
  'events',
  { id: pipe(string(), column({ type: 'uuid' })) },
  { primaryKey: 'id', schema: 'audit' },
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

function rotate<T>(values: readonly T[]): T[] {
  return values.length < 2 ? [...values] : [...values.slice(1), values[0]!]
}

function mixedCatalog(): CatalogSnapshot {
  return {
    tables: [
      {
        schema: 'public',
        name: 'users',
        columns: [
          { name: 'email', dataType: 'text', isNullable: false },
          { name: 'id', dataType: 'uuid', isNullable: false },
        ],
      },
      {
        name: 'accounts',
        columns: [
          { name: 'removedZ', dataType: 'text', isNullable: true },
          { name: 'indexFirst', dataType: 'text', isNullable: false },
          { name: 'madeRequired', dataType: 'text', isNullable: true },
          { name: 'id', dataType: 'uuid', isNullable: false },
          { name: 'changedType', dataType: 'integer', isNullable: false },
          { name: 'madeNullable', dataType: 'text', isNullable: false },
          { name: 'indexSecond', dataType: 'text', isNullable: false },
          { name: 'removedA', dataType: 'text', isNullable: true },
        ],
        indexes: [
          { name: 'stale_z_idx', columns: ['removedZ'], unique: false },
          { name: 'stale_a_idx', columns: ['removedA'], unique: false },
        ],
      },
      {
        schema: 'public',
        name: 'z_orphan',
        columns: [
          { name: 'child', dataType: 'text', isNullable: true },
          { name: 'id', dataType: 'uuid', isNullable: false },
        ],
        indexes: [{ name: 'orphan_child_idx', columns: ['child'], unique: false }],
      },
      {
        schema: 'public',
        name: 'a_orphan',
        columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
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
          kind: 'drop_index',
          schema: 'public',
          table: 'users',
          index: 'users_stale_idx',
        },
        {
          kind: 'drop_column',
          schema: 'public',
          table: 'users',
          column: 'legacy',
        },
        {
          kind: 'drop_table',
          schema: 'public',
          table: 'orphan',
        },
      ],
    })
  })

  it('orders a complete plan by canonical phase and target', () => {
    expect(
      planMigration([Comments, Users, AuditEvents, Accounts], mixedCatalog()),
    ).toEqual({
      steps: [
        { kind: 'create_schema', schema: 'audit' },
        { kind: 'create_table', schema: 'audit', table: 'events' },
        { kind: 'create_table', table: 'comments' },
        {
          kind: 'add_column',
          table: 'accounts',
          column: 'addedReference',
          dataType: 'uuid',
          notNull: true,
        },
        {
          kind: 'add_column',
          table: 'accounts',
          column: 'addedText',
          dataType: 'text',
          notNull: true,
        },
        {
          kind: 'alter_column_type',
          table: 'accounts',
          column: 'changedType',
          dataType: 'text',
        },
        {
          kind: 'drop_not_null',
          table: 'accounts',
          column: 'madeNullable',
        },
        {
          kind: 'set_not_null',
          table: 'accounts',
          column: 'madeRequired',
        },
        {
          kind: 'create_index',
          table: 'accounts',
          index: 'accounts_ordered_idx',
          columns: ['indexSecond', 'indexFirst'],
          unique: false,
        },
        {
          kind: 'add_foreign_key',
          table: 'accounts',
          column: 'addedReference',
          references: { schema: 'public', table: 'users', column: 'id' },
        },
        {
          kind: 'add_foreign_key',
          table: 'comments',
          column: 'userId',
          references: { schema: 'public', table: 'users', column: 'id' },
        },
        {
          kind: 'drop_index',
          table: 'accounts',
          index: 'stale_a_idx',
        },
        {
          kind: 'drop_index',
          table: 'accounts',
          index: 'stale_z_idx',
        },
        { kind: 'drop_column', table: 'accounts', column: 'removedA' },
        { kind: 'drop_column', table: 'accounts', column: 'removedZ' },
        { kind: 'drop_table', schema: 'public', table: 'a_orphan' },
        { kind: 'drop_table', schema: 'public', table: 'z_orphan' },
      ],
    })
  })

  it('uses locale-independent code-unit target ordering', () => {
    const Lowercase = defineTable(
      'alpha',
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id' },
    )
    const Uppercase = defineTable(
      'Zulu',
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id' },
    )

    expect(planMigration([Lowercase, Uppercase], { tables: [] })).toEqual({
      steps: [
        { kind: 'create_table', table: 'Zulu' },
        { kind: 'create_table', table: 'alpha' },
      ],
    })
  })

  it('is invariant to registered table and catalog collection order', () => {
    const handles = [Accounts, AuditEvents, Comments, Users]
    const catalog = mixedCatalog()
    const expected = planMigration(handles, catalog)
    const originalCatalog = structuredClone(catalog)

    const catalogs = [catalog, structuredClone(catalog), structuredClone(catalog)]
    catalogs[1]!.tables.reverse()
    catalogs[2]!.tables = rotate(catalogs[2]!.tables)
    for (const candidate of catalogs.slice(1)) {
      for (const table of candidate.tables) {
        table.columns = rotate(table.columns)
        if (table.indexes) table.indexes.reverse()
      }
    }

    for (const registered of [handles, [...handles].reverse(), rotate(handles)]) {
      for (const candidate of catalogs) {
        expect(planMigration(registered, candidate)).toEqual(expected)
      }
    }
    expect(catalog).toEqual(originalCatalog)
  })

  it('ignores non-semantic constraint order but preserves ordered key sequences', () => {
    const Teams = defineTable(
      'teams',
      {
        tenantId: pipe(string(), column({ type: 'uuid' })),
        teamId: pipe(string(), column({ type: 'uuid' })),
      },
      { primaryKey: ['tenantId', 'teamId'], schema: 'public' },
    )
    const Memberships = defineTable(
      'memberships',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        primaryTeamId: reference(Teams, 'teamId'),
        secondaryTeamId: reference(Teams, 'teamId'),
        primaryEmail: pipe(string(), column({ type: 'text', unique: true })),
        secondaryEmail: pipe(string(), column({ type: 'text', unique: true })),
      },
      { primaryKey: 'id', schema: 'public' },
    )
    const catalog: CatalogSnapshot = {
      tables: [
        {
          schema: 'public',
          name: 'teams',
          columns: [
            { name: 'teamId', dataType: 'uuid', isNullable: false },
            { name: 'tenantId', dataType: 'uuid', isNullable: false },
          ],
          primaryKey: { name: 'teams_pkey', columns: ['tenantId', 'teamId'] },
        },
        {
          schema: 'public',
          name: 'memberships',
          columns: [
            { name: 'secondaryEmail', dataType: 'text', isNullable: false },
            { name: 'primaryTeamId', dataType: 'uuid', isNullable: false },
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'secondaryTeamId', dataType: 'uuid', isNullable: false },
            { name: 'primaryEmail', dataType: 'text', isNullable: false },
          ],
          uniqueConstraints: [
            { name: 'memberships_secondary_email_key', columns: ['secondaryEmail'] },
            { name: 'memberships_primary_email_key', columns: ['primaryEmail'] },
          ],
          foreignKeys: [
            {
              name: 'memberships_secondary_team_fkey',
              columns: ['secondaryTeamId'],
              referencedSchema: 'public',
              referencedTable: 'teams',
              referencedColumns: ['teamId'],
              onDelete: 'no action',
              onUpdate: 'no action',
            },
            {
              name: 'memberships_primary_team_fkey',
              columns: ['primaryTeamId'],
              referencedSchema: 'public',
              referencedTable: 'teams',
              referencedColumns: ['teamId'],
              onDelete: 'no action',
              onUpdate: 'no action',
            },
          ],
        },
      ],
    }
    const permuted = structuredClone(catalog)
    permuted.tables.reverse()
    permuted.tables[0]!.columns.reverse()
    permuted.tables[0]!.uniqueConstraints!.reverse()
    permuted.tables[0]!.foreignKeys!.reverse()

    expect(planMigration([Memberships, Teams], catalog)).toEqual({ steps: [] })
    expect(planMigration([Teams, Memberships], permuted)).toEqual({ steps: [] })

    const reversedKey = structuredClone(catalog)
    reversedKey.tables[0]!.primaryKey!.columns.reverse()
    expect(() => planMigration([Memberships, Teams], reversedKey)).toThrow(
      /primary key change/i,
    )
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
