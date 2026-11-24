import { access, readFile } from 'node:fs/promises'
import { integer, number, pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import type { createDatabase, defineTable } from '@/index'
import type { snakeCase } from '@/naming'
import type { SchemaError, column, isTableHandle, reference } from '@/schema'

import { withSqliteDatabase } from './sqliteIntegration'

it('should migrate and query tables authored through the schema subpath with the root runtime', async () => {
  const packageName = '@stratom/orm'
  const schemaSubpath = '@stratom/orm/schema'
  const library = (await import(packageName)) as {
    createDatabase: typeof createDatabase
    defineTable: typeof defineTable
    SchemaError: typeof SchemaError
    isTableHandle: typeof isTableHandle
  }

  const authoring = (await import(schemaSubpath)) as {
    defineTable: typeof defineTable
    column: typeof column
    reference: typeof reference
  }

  expect(() => authoring.defineTable('', { id: string() }, { primaryKey: 'id' })).toThrow(
    library.SchemaError,
  )

  const Parents = authoring.defineTable('parents', { id: string() }, { primaryKey: 'id' })
  const Children = authoring.defineTable(
    'children',
    {
      id: pipe(string(), authoring.column({ unique: true })),
      parentId: authoring.reference(Parents, 'id'),
      lazyParentId: authoring.reference(string(), () => Parents, 'id'),
    },
    { primaryKey: 'id' },
  )

  expect(library.isTableHandle(Children)).toBe(true)

  await withSqliteDatabase(
    [Parents, Children],
    async ({ db, native }) => {
      await db.migrate().execute()
      await db.insert(Parents).values({ id: 'parent' }).execute()

      await db
        .insert(Children)
        .values({ id: 'child', parentId: 'parent', lazyParentId: 'parent' })
        .execute()

      expect(await db.from(Children).execute()).toEqual([
        { id: 'child', parentId: 'parent', lazyParentId: 'parent' },
      ])

      expect(native.prepare('pragma foreign_key_list(children)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: 'parents', from: 'parentId', to: 'id' }),
          expect.objectContaining({ table: 'parents', from: 'lazyParentId', to: 'id' }),
        ]),
      )
    },
    { library },
  )
})

it('should ship declarations for the main entry and every exported subpath', async () => {
  const root = new URL('../../../', import.meta.url)
  const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
    types: string
    exports: Record<string, { types: string }>
  }

  const declarations = [
    metadata.types,
    ...Object.values(metadata.exports).map((entry) => entry.types),
  ]

  for (const declaration of declarations) {
    await expect(access(new URL(declaration, root))).resolves.toBeUndefined()
  }
})

it('should create a table and round-trip a row through the built package', async () => {
  // A variable specifier keeps typecheck independent of a prior build.
  const packageName = '@stratom/orm'
  const library = (await import(packageName)) as {
    createDatabase: typeof createDatabase
    defineTable: typeof defineTable
  }

  const Records = library.defineTable(
    'package_records',
    { id: pipe(number(), integer()), label: string() },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase(
    [Records],
    async ({ db }) => {
      await db.migrate().execute()
      await db.insert(Records).values({ id: 1, label: 'package value' }).execute()

      expect(await db.from(Records).where({ id: 1 }).execute()).toEqual([
        { id: 1, label: 'package value' },
      ])
    },
    { library },
  )
})

it('should expose snakeCase only through the naming subpath and use it from the built package', async () => {
  const packageName = '@stratom/orm'
  const namingSubpath = '@stratom/orm/naming'
  const library = (await import(packageName)) as {
    createDatabase: typeof createDatabase
    defineTable: typeof defineTable
  }

  const naming = (await import(namingSubpath)) as { snakeCase: typeof snakeCase }

  expect(library).not.toHaveProperty('snakeCase')

  expect(naming.snakeCase({ column: 'homeAddress2', table: 'users' })).toBe(
    'home_address_2',
  )

  const Records = library.defineTable(
    'package_naming',
    { userId: number(), fullName: string() },
    { primaryKey: 'userId' },
  )

  await withSqliteDatabase(
    [Records],
    async ({ db, native }) => {
      await db.migrate().execute()
      await db.insert(Records).values({ userId: 1, fullName: 'Ada' }).execute()

      expect(await db.from(Records).where('fullName', 'eq', 'Ada').execute()).toEqual([
        { userId: 1, fullName: 'Ada' },
      ])

      expect(
        native.prepare('select user_id, full_name from package_naming').all(),
      ).toEqual([{ user_id: 1, full_name: 'Ada' }])
    },
    { library, naming: { columns: naming.snakeCase } },
  )
})
