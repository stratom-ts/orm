import { expect, it } from 'vitest'

import { withSqliteDatabase } from './sqliteIntegration'

it('should execute bound reads, returning writes, and writes without rows on native SQLite', async () => {
  await withSqliteDatabase([], async ({ db }) => {
    await db.sql`create table raw_values (id integer primary key, value text)`

    const values = ['ordinary', null, "'; drop table raw_values; --"]
    for (const [index, value] of values.entries()) {
      expect(
        await db.sql`insert into raw_values (id, value) values (${index + 1}, ${value}) returning id, value`,
      ).toEqual([{ id: index + 1, value }])

      expect(await db.sql`select value from raw_values where id = ${index + 1}`).toEqual([
        { value },
      ])
    }

    expect(
      await db.sql`update raw_values set value = ${'updated'} where id = ${1}`,
    ).toEqual([])

    expect(await db.sql`select id, value from raw_values order by id`).toEqual([
      { id: 1, value: 'updated' },
      { id: 2, value: null },
      { id: 3, value: values[2] },
    ])
  })
})

it('should roll back a raw SQLite write after the transaction callback fails', async () => {
  await withSqliteDatabase([], async ({ db }) => {
    await db.sql`create table raw_values (value text)`
    const failure = new Error('rollback raw write')
    await expect(
      db.transaction(async (trx) => {
        await trx.sql`insert into raw_values values (${'rolled back'})`

        expect(await trx.sql`select value from raw_values`).toEqual([
          { value: 'rolled back' },
        ])

        throw failure
      }),
    ).rejects.toBe(failure)

    expect(await db.sql`select value from raw_values`).toEqual([])
  })
})

it('should keep dynamic identifiers and fragment values separate on the native driver', async () => {
  await withSqliteDatabase([], async ({ db }) => {
    const relation = db.sql.id('main', 'odd.table"; drop table users; --')
    const column = db.sql.id('v"alue')
    await db.sql`create table ${relation} (${column} text)`
    const value = "'; drop table users; --"
    await db.sql`insert into ${relation} values (${value})`
    const filter = db.sql.fragment`${column} = ${value}`
    const query = db.sql
      .fragment`select ${column} as value from ${relation} where ${filter}`

    expect(await db.execute(query)).toEqual([{ value }])
  })
})
