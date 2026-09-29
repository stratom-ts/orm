import { describe, expect, it } from 'vitest'

import type { CatalogRelation, CatalogSnapshot, CatalogTable } from '@/dialects'
import { sqliteCatalog } from '@/dialects/sqlite'

function isSqlInputValue(
  value: unknown,
): value is string | number | bigint | null | Uint8Array {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  )
}

const nodeSqliteSupported = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 13)
})()

function relationNamed(snapshot: CatalogSnapshot, name: string): CatalogRelation {
  const relation = snapshot.namespaces.items[0]?.relations.items.find(
    (entry) => entry.identity.relation.spelling === name,
  )
  expect(relation).toBeDefined()

  if (relation === undefined) throw new Error(`Missing SQLite relation ${name}`)

  return relation
}

function tableOf(relation: CatalogRelation): CatalogTable {
  expect(relation.table.state).toBe('present')

  if (relation.table.state !== 'present')
    throw new Error(
      `Missing SQLite table evidence for ${relation.identity.relation.spelling}`,
    )

  return relation.table.value
}

describe('SQLite catalog introspection with node:sqlite', () => {
  it.runIf(nodeSqliteSupported)(
    'observes a real SQLite catalog with canonical identities and rowid generation',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE parent (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL DEFAULT 'parent',
          note TEXT
        );
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
        );
        CREATE INDEX child_parent_idx ON child(parent_id);
      `)

        const snapshot = await sqliteCatalog.introspectCatalog(
          {
            execute: async ({ sql, params }) =>
              database.prepare(sql).all(
                ...params.map((value) => {
                  if (!isSqlInputValue(value))
                    throw new TypeError('Invalid node:sqlite SQL input value')

                  return value
                }),
              ),
          },
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )

        expect(snapshot.source).toMatchObject({ dialect: 'sqlite' })
        expect(snapshot.namespaces.coverage).toEqual({ state: 'complete' })
        const relations = snapshot.namespaces.items[0]?.relations.items ?? []
        expect(relations.map(({ identity }) => identity.relation.spelling)).toEqual([
          'child',
          'parent',
        ])

        const parent = relationNamed(snapshot, 'parent')
        const child = relationNamed(snapshot, 'child')
        const parentTable = tableOf(parent)
        const childTable = tableOf(child)

        expect(parent.management).toBe('managed')

        expect(parentTable.columns.items[0]!.dataType).toMatchObject({
          state: 'present',
          value: { native: 'INTEGER', comparisonKey: 'integer' },
        })

        expect(parentTable.columns.items[0]!.generation).toEqual({
          state: 'present',
          value: { kind: 'rowidAlias', autoIncrement: true },
        })

        expect(parentTable.columns.items[1]!.default).toMatchObject({
          state: 'present',
          value: {
            kind: 'literal',
            native: "'parent'",
            comparisonKey: { state: 'present', value: "'parent'" },
          },
        })

        expect(parentTable.columns.items[1]!.nullable).toEqual({
          state: 'present',
          value: false,
        })

        expect(parentTable.columns.items[2]!.nullable).toEqual({
          state: 'present',
          value: true,
        })

        expect(childTable.foreignKeys.items[0]).toMatchObject({
          columns: ['parent_id'],
          referencedRelation: {
            namespace: [
              {
                role: 'database',
                identifier: { spelling: 'main', comparisonKey: 'main' },
              },
            ],
            relation: { spelling: 'parent', comparisonKey: 'parent' },
          },
          referencedColumns: ['id'],
          validity: { state: 'present', value: 'valid' },
          onDelete: 'cascade',
        })

        expect(childTable.indexes.items).toMatchObject([
          {
            name: { state: 'present', value: 'child_parent_idx' },
            columns: ['parent_id'],
          },
        ])
      } finally {
        database.close()
      }
    },
  )

  it.runIf(nodeSqliteSupported)(
    'observes attached and temporary relations and maps UNIQUE auto-indexes conservatively',
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(':memory:')

      try {
        database.exec(`
          ATTACH DATABASE ':memory:' AS aux;
          CREATE TABLE aux.external_data (id INTEGER PRIMARY KEY);
          CREATE TEMP TABLE transient_data (id INTEGER PRIMARY KEY);
          CREATE TABLE unique_data (left_value TEXT, right_value TEXT, UNIQUE (left_value, right_value));
        `)

        const snapshot = await sqliteCatalog.introspectCatalog(
          {
            execute: async ({ sql, params }) =>
              database.prepare(sql).all(
                ...params.map((value) => {
                  if (!isSqlInputValue(value))
                    throw new TypeError('Invalid node:sqlite SQL input value')

                  return value
                }),
              ),
          },
          {
            relations: [],
            absentRelations: [],
            completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
          },
        )
        const unique = tableOf(relationNamed(snapshot, 'unique_data'))

        expect(unique.uniqueConstraints.items).toMatchObject([
          {
            columns: ['left_value', 'right_value'],
            semantics: { state: 'present', value: { kind: 'simple' } },
            validity: { state: 'present', value: 'valid' },
          },
        ])

        expect(unique.indexes.items).toEqual([])
        expect(relationNamed(snapshot, 'unique_data').management).toBe('unmanaged')

        expect(snapshot.diagnostics.map(({ code }) => code)).toEqual([
          'catalog.sqlite.attached',
          'catalog.sqlite.temporary',
          'catalog.sqlite.unmanaged-relation',
          'catalog.sqlite.unmanaged-relation',
        ])
      } finally {
        database.close()
      }
    },
  )
})
