import { beforeAll, expect, it } from 'vitest'

import { waitForPostgres } from './postgres.setup'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

it('executes bound reads, returning writes, and writes without rows on native PostgreSQL', async () => {
  await withPostgresDatabase([], async ({ db, schema }) => {
    const relation = `${quoteIdentifier(schema)}."raw_values"`
    await db.execute({
      sql: `create table ${relation} (id integer primary key, value text)`,
      params: [],
    })

    const values = ['ordinary', null, "'; drop table raw_values; --"]
    for (const [index, value] of values.entries()) {
      expect(
        await db.execute({
          sql: `insert into ${relation} (id, value) values ($1, $2) returning id, value`,
          params: [index + 1, value],
        }),
      ).toEqual([{ id: index + 1, value }])

      expect(
        await db.execute({
          sql: `select value from ${relation} where id = $1`,
          params: [index + 1],
        }),
      ).toEqual([{ value }])
    }

    expect(
      await db.execute({
        sql: `update ${relation} set value = $1 where id = $2`,
        params: ['updated', 1],
      }),
    ).toEqual([])

    expect(
      await db.execute({
        sql: `select id, value from ${relation} order by id`,
        params: [],
      }),
    ).toEqual([
      { id: 1, value: 'updated' },
      { id: 2, value: null },
      { id: 3, value: values[2] },
    ])
  })
})

it('rolls back a raw PostgreSQL write after the transaction callback fails', async () => {
  await withPostgresDatabase([], async ({ db, schema }) => {
    const relation = `${quoteIdentifier(schema)}."raw_values"`
    await db.execute({ sql: `create table ${relation} (value text)`, params: [] })
    const failure = new Error('rollback raw write')
    await expect(
      db.transaction(async (trx) => {
        await trx.execute({
          sql: `insert into ${relation} values ($1)`,
          params: ['rolled back'],
        })

        expect(
          await trx.execute({ sql: `select value from ${relation}`, params: [] }),
        ).toEqual([{ value: 'rolled back' }])

        throw failure
      }),
    ).rejects.toBe(failure)

    expect(
      await db.execute({ sql: `select value from ${relation}`, params: [] }),
    ).toEqual([])
  })
})
