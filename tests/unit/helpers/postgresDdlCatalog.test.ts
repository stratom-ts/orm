import { expect, it } from 'vitest'

import { applyPostgresFixtureDdl, postgresFixtureCatalogRows } from './postgresDdlCatalog'

type Tables = Parameters<typeof applyPostgresFixtureDdl>[1]

const text = (name: string) => ({ name, dataType: 'text', isNullable: true })

it('reports a renamed column through local members and inbound foreign keys', () => {
  const tables: Tables = [
    {
      schema: 'app',
      name: 'users',
      columns: [text('id'), text('displayName')],
      primaryKey: ['id'],
      uniqueConstraints: [{ name: 'users_name_key', columns: ['displayName'] }],
      indexes: [
        { name: 'historical_name', columns: ['displayName', 'id'], unique: false },
      ],
    },
    {
      schema: 'app',
      name: 'posts',
      columns: [text('author')],
      foreignKeys: [
        {
          name: 'posts_author_fkey',
          columns: ['author'],
          referencedSchema: 'app',
          referencedTable: 'users',
          referencedColumns: ['displayName'],
        },
      ],
    },
  ]

  applyPostgresFixtureDdl(
    'alter table "app"."users" rename column "displayName" to "full ""name"""',
    tables,
  )

  expect(tables[0].columns.map((column) => column.name)).toEqual(['id', 'full "name"'])
  expect(tables[0].uniqueConstraints?.[0].columns).toEqual(['full "name"'])
  expect(tables[0].indexes?.[0].columns).toEqual(['full "name"', 'id'])
  expect(tables[1].foreignKeys?.[0].referencedColumns).toEqual(['full "name"'])

  expect(
    postgresFixtureCatalogRows('-- catalog:column', tables)?.map(
      (row) => (row as { column_name: string }).column_name,
    ),
  ).toEqual(['id', 'full "name"', 'author'])
})
