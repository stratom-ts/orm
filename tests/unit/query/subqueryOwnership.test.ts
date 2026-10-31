import { number } from 'valibot'
import { expect, it } from 'vitest'

import { alias, createDatabase, defineTable, exists, scalar } from '@/index'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

const Records = defineTable('scope_subquery', { id: number() }, { primaryKey: 'id' })
it('rejects root, parent and sibling scope mixtures before SQL and preserves expired scope checks', async () => {
  const controls = createControllableProvider()
  const db = createDatabase({
    connector: customConnector('postgresql'),
    operationSessionProvider: controls.provider,
    schemas: [Records],
  })

  const root = db.from(Records).select([Records.id])
  let expired = root

  await db.transaction(async (trx) => {
    const scoped = trx.from(Records).select([Records.id])
    expired = scoped
    expect(() => trx.from(Records).where(exists(root)).compile()).toThrow(/client scope/)
    expect(() => db.from(Records).where(exists(scoped)).compile()).toThrow(/client scope/)

    await trx.transaction(async (nested) => {
      expect(() => nested.from(Records).where(exists(scoped)).compile()).toThrow(
        /client scope/,
      )
    })

    expect(
      trx
        .from(Records)
        .select((b) => [b.as(scalar(scoped), 'id')])
        .compile().params,
    ).toEqual([])
  })

  expect(controls.calls.map((c) => c.sql)).toEqual([
    'begin',
    'savepoint sp_1',
    'release savepoint sp_1',
    'commit',
  ])

  await expect(expired.execute()).rejects.toThrow(/transaction|scope|expired/i)
  const named = alias(Records, 'named')
  expect(() => db.from(named).compile()).not.toThrow()
  const prepared = db.from(Records).where(exists(root))
  await db.close()
  await expect(prepared.execute()).rejects.toThrow(/closed/i)
})
