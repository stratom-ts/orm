import { expect, expectTypeOf, it, vi } from 'vitest'

import { compileCommonOperationCommand } from '@/dialects/operations'
import { QueryError, createDatabase, postgresDialect, sqliteDialect } from '@/index'
import type { Db, TransactionOptions } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import {
  createMockPostgresConnector,
  createMockStatement,
} from './dialects/postgresNativeClientFixtures'
import {
  createControllableProvider,
  customConnector,
} from './helpers/operationSessionFixtures'

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
    { behavior: 'deferred' },
    { behavior: 'immediate', isolationLevel: 'serializable' },
    { behavior: 'immediate', isolationLevel: undefined },
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

  const immediate = { kind: 'begin', behavior: 'immediate' } as const
  expect(sqliteDialect.operations.compile(immediate)).toEqual({
    sql: 'begin immediate',
    params: [],
  })

  expect(() => compileCommonOperationCommand(command)).toThrow(QueryError)
  expect(() => compileCommonOperationCommand(immediate)).toThrow(QueryError)
  expect(() => postgresDialect.operations.compile(immediate)).toThrow(QueryError)
  expect(() => sqliteDialect.operations.compile(command)).toThrow(QueryError)

  for (const dialect of [postgresDialect, sqliteDialect]) {
    expect(() =>
      dialect.operations.compile({ ...command, ...immediate } as never),
    ).toThrow(QueryError)
  }

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
    | Readonly<{ isolationLevel: 'serializable'; behavior?: never }>
    | Readonly<{ behavior: 'immediate'; isolationLevel?: never }>
  >()

  expectTypeOf<Parameters<Db['transaction']>[1]>().toEqualTypeOf<
    TransactionOptions | undefined
  >()

  // @ts-expect-error Only serializable isolation is supported.
  const unsupported: TransactionOptions = { isolationLevel: 'read committed' }
  const combined: TransactionOptions = {
    isolationLevel: 'serializable',
    // @ts-expect-error Dialect-specific intent options are mutually exclusive.
    behavior: 'immediate',
  }

  expectTypeOf(unsupported).toEqualTypeOf<TransactionOptions>()
  expectTypeOf(combined).toEqualTypeOf<TransactionOptions>()
})

it.each([
  {
    dialect: 'postgresql',
    options: { isolationLevel: 'serializable' },
    begin: 'begin isolation level serializable',
  },
  { dialect: 'sqlite', options: { behavior: 'immediate' }, begin: 'begin immediate' },
] as const)(
  'copies $dialect options before a queued transaction can observe caller mutation',
  async ({ dialect, options, begin }) => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(dialect),
      schemas: [],
      operationSessionProvider: controls.provider,
    })

    const entered = deferred()
    const gate = deferred()
    const first = db.transaction(async () => {
      entered.resolve()
      await gate.promise
    })

    await entered.promise
    const second = db.transaction(async () => 42, options)

    Object.assign(options, {
      isolationLevel: undefined,
      behavior: undefined,
      kind: 'rollback',
    })

    gate.resolve()
    await first
    expect(await second).toBe(42)

    expect(
      controls.calls.map((call) => call.sql).filter((sql) => sql.startsWith('begin')),
    ).toEqual(['begin', begin])

    expect(controls.calls.map((call) => call.sql)).not.toContain('rollback')
    await db.close()
  },
)

it.each([
  { dialect: 'postgresql', options: { behavior: 'immediate' } },
  { dialect: 'sqlite', options: { isolationLevel: 'serializable' } },
] as const)(
  'rejects unsupported intent on $dialect before entering the callback',
  async ({ dialect, options }) => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(dialect),
      schemas: [],
      operationSessionProvider: controls.provider,
    })

    const callback = vi.fn<() => Promise<number>>(async () => 42)
    await expect(db.transaction(callback, options)).rejects.toThrow(QueryError)
    expect(callback).not.toHaveBeenCalled()
    await expect(db.transaction(callback)).resolves.toBe(42)
    await db.close()
  },
)

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
