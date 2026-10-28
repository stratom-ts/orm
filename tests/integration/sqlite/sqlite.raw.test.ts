import { expect, it } from 'vitest'

import { withSqliteDatabase } from './sqliteIntegration'

it('executes bound reads, returning writes, and writes without rows on native SQLite', async () => {
  await withSqliteDatabase([], async ({ db }) => {
    await db.execute({
      sql: 'create table raw_values (id integer primary key, value text)',
      params: [],
    })

    const values = ['ordinary', null, "'; drop table raw_values; --"]
    for (const [index, value] of values.entries()) {
      expect(
        await db.execute({
          sql: 'insert into raw_values (id, value) values (?, ?) returning id, value',
          params: [index + 1, value],
        }),
      ).toEqual([{ id: index + 1, value }])

      expect(
        await db.execute({
          sql: 'select value from raw_values where id = ?',
          params: [index + 1],
        }),
      ).toEqual([{ value }])
    }

    expect(
      await db.execute({
        sql: 'update raw_values set value = ? where id = ?',
        params: ['updated', 1],
      }),
    ).toEqual([])

    expect(
      await db.execute({
        sql: 'select id, value from raw_values order by id',
        params: [],
      }),
    ).toEqual([
      { id: 1, value: 'updated' },
      { id: 2, value: null },
      { id: 3, value: values[2] },
    ])
  })
})

it('rolls back a raw SQLite write after the transaction callback fails', async () => {
  await withSqliteDatabase([], async ({ db }) => {
    await db.execute({ sql: 'create table raw_values (value text)', params: [] })
    const failure = new Error('rollback raw write')
    await expect(
      db.transaction(async (trx) => {
        await trx.execute({
          sql: 'insert into raw_values values (?)',
          params: ['rolled back'],
        })

        expect(
          await trx.execute({ sql: 'select value from raw_values', params: [] }),
        ).toEqual([{ value: 'rolled back' }])

        throw failure
      }),
    ).rejects.toBe(failure)

    expect(await db.execute({ sql: 'select value from raw_values', params: [] })).toEqual(
      [],
    )
  })
})
