import { expect, expectTypeOf, it, vi } from 'vitest'

import { compileCommonOperationCommand } from '@/dialects/operations'
import { QueryError, createDatabase, postgresDialect, sqliteDialect } from '@/index'
import type { Db, TransactionOptions } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import {
  createMockPostgresConnector,
  createMockStatement,
} from './dialects/postgresNativeClientFixtures'

it('establishes serialization before the callback and inherits it through savepoints', async () => {
  const connector = createMockPostgresConnector()
  const db = createDatabase({ connector, schemas: [] })
  const result = await db.transaction(
    async (tx) => {
      expect(connector.prepared).toContain('begin isolation level serializable')
      await tx.transaction(async () => 1)
      const callback = vi.fn<() => Promise<number>>(async () => 0)
      await expect(
        tx.transaction(callback, { isolationLevel: 'serializable' }),
      ).rejects.toThrow(/nested/)

      expect(callback).not.toHaveBeenCalled()
      return 42
    },
    { isolationLevel: 'serializable' },
  )

  expect(result).toBe(42)
  expect(connector.prepared).toContain('savepoint sp_1')
  expect(connector.prepared).not.toContain('savepoint sp_2')
  expect(connector.prepared).toContain('commit')
  await db.close()
})

it('rejects invalid options before running user work and leaves the client usable', async () => {
  const connector = createMockPostgresConnector()
  const db = createDatabase({ connector, schemas: [] })
  const callback = vi.fn<() => Promise<number>>(async () => 0)
  for (const options of [
    null,
    {},
    { isolationLevel: 'read committed' },
    { isolationLevel: 'serializable', mode: 'immediate' },
  ]) {
    await expect(db.transaction(callback, options as never)).rejects.toThrow(QueryError)
  }

  expect(callback).not.toHaveBeenCalled()
  expect(connector.prepared).toEqual([])
  await db.transaction(callback)
  expect(connector.prepared).toContain('begin')
  await db.close()
})

it('compiles supported dialect contracts and refuses an unsupported capability', () => {
  const command = { kind: 'begin', isolationLevel: 'serializable' } as const
  expect(postgresDialect.operations.compile(command)).toEqual({
    sql: 'begin isolation level serializable',
    params: [],
  })

  expect(sqliteDialect.operations.compile(command)).toEqual({
    sql: 'begin immediate',
    params: [],
  })

  expect(() => compileCommonOperationCommand(command)).toThrow(QueryError)

  for (const dialect of [postgresDialect, sqliteDialect]) {
    expect(dialect.operations.compile({ kind: 'begin' })).toEqual({
      sql: 'begin',
      params: [],
    })

    expect(() =>
      dialect.operations.compile({ kind: 'begin', isolationLevel: 'invalid' } as never),
    ).toThrow(QueryError)
  }
})

it('exports the accepted option and rejects unsupported isolation levels at the type boundary', () => {
  expectTypeOf<TransactionOptions>().toEqualTypeOf<
    Readonly<{ isolationLevel: 'serializable' }>
  >()

  expectTypeOf<Parameters<Db['transaction']>[1]>().toEqualTypeOf<
    TransactionOptions | undefined
  >()

  // @ts-expect-error Only serializable isolation is supported.
  const unsupported: TransactionOptions = { isolationLevel: 'read committed' }
  expect(unsupported).toBeDefined()
})

it('copies options before a queued transaction can observe caller mutation', async () => {
  const connector = createMockPostgresConnector()
  const db = createDatabase({ connector, schemas: [] })
  const entered = deferred()
  const gate = deferred()
  const first = db.transaction(async () => {
    entered.resolve()
    await gate.promise
  })

  await entered.promise
  const options = { isolationLevel: 'serializable' } as const
  const second = db.transaction(async () => 42, options)
  Object.assign(options, { isolationLevel: undefined, kind: 'rollback' })
  gate.resolve()
  await first
  expect(await second).toBe(42)

  expect(connector.prepared.filter((sql) => sql.startsWith('begin'))).toEqual([
    'begin',
    'begin isolation level serializable',
  ])

  expect(connector.prepared).not.toContain('rollback')
  await db.close()
})

it('does not enter a callback after a failed begin and releases the session for the next attempt', async () => {
  let fail = true
  const connector = createMockPostgresConnector({
    onPrepare(sql) {
      if (sql === 'begin isolation level serializable' && fail) {
        fail = false
        throw Object.assign(new Error('begin rejected'), { code: '40001' })
      }

      return createMockStatement()
    },
  })

  const db = createDatabase({ connector, schemas: [] })
  const callback = vi.fn<() => Promise<number>>(async () => 42)
  await expect(
    db.transaction(callback, { isolationLevel: 'serializable' }),
  ).rejects.toMatchObject({ kind: 'transient', retryable: true })

  expect(callback).not.toHaveBeenCalled()
  expect(await db.transaction(callback, { isolationLevel: 'serializable' })).toBe(42)
  await db.close()
})
