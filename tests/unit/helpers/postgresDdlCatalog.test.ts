import { expect, it } from 'vitest'

import { applyPostgresFixtureDdl, postgresFixtureCatalogRows } from './postgresDdlCatalog'

type Tables = Parameters<typeof applyPostgresFixtureDdl>[1]

const text = (name: string) => ({ name, dataType: 'text', isNullable: true })

it('should report a renamed column through local members and inbound foreign keys', () => {
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

it('should report unique and foreign-key constraints added by DDL', () => {
  const tables: Tables = [
    { schema: 'app', name: 'users', columns: [text('id'), text('email')] },
    { schema: 'app', name: 'posts', columns: [text('author')] },
  ]

  for (const sql of [
    'alter table "app"."users" add constraint "users_email_key" unique ("email")',
    'alter table "app"."posts" add constraint "posts_author_fkey" foreign key ("author") references "app"."users" ("email") on delete cascade',
  ])
    applyPostgresFixtureDdl(sql, tables)

  expect(
    postgresFixtureCatalogRows('select con.contype as constraint_type', tables),
  ).toMatchObject([
    {
      table_name: 'users',
      constraint_name: 'users_email_key',
      constraint_type: 'u',
      columns: ['email'],
    },
    {
      table_name: 'posts',
      constraint_name: 'posts_author_fkey',
      constraint_type: 'f',
      columns: ['author'],
      referenced_schema: 'app',
      referenced_table: 'users',
      referenced_columns: ['email'],
      on_delete: 'cascade',
      on_update: 'no action',
    },
  ])
})

it('should report inline unique constraints declared by create table', () => {
  const tables: Tables = []

  applyPostgresFixtureDdl(
    `create table "app"."users" ("id" text not null, "email" text constraint "users_email_uq" unique, "handle" text not null unique default 'x', "note" text default 'unique')`,
    tables,
  )

  expect(
    postgresFixtureCatalogRows('select con.contype as constraint_type', tables),
  ).toMatchObject([
    {
      table_name: 'users',
      constraint_name: 'users_email_uq',
      constraint_type: 'u',
      columns: ['email'],
    },
    {
      table_name: 'users',
      constraint_name: 'users_handle_key',
      constraint_type: 'u',
      columns: ['handle'],
    },
  ])
})
