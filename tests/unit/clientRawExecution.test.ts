import { array, number, object, parse, pipe, string } from 'valibot'
import { expect, expectTypeOf, it, vi } from 'vitest'

import type { CompiledQuery, Db } from '@/index'
import { DriverError, QueryError, column, createDatabase, defineTable } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import { createMockPostgresConnector } from './dialects/postgresNativeClientFixtures'
import {
  createControllableProvider,
  customConnector,
} from './helpers/operationSessionFixtures'

/** Creates a client whose provider exposes scheduling and physical-session evidence. */
function controlled(options?: Parameters<typeof createControllableProvider>[0]) {
  const controls = createControllableProvider(options)
  const db = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [],
    operationSessionProvider: controls.provider,
  })

  return { db, controls }
}

it('preserves fixed SQL, ordered bound values, native row order, and empty rows without tables', async () => {
  const sql = 'select $1 as value, $2 as other'
  const params = ["'; drop table users; --", null]
  const rows = [{ value: 'second' }, { value: 'first' }]
  const controls = createControllableProvider({
    queryRows: (text) => (text === sql ? rows : []),
  })

  const observed: CompiledQuery[] = []
  const originalOpen = controls.provider.open.bind(controls.provider)
  controls.provider.open = async () => {
    const session = await originalOpen()
    const originalQuery = session.query.bind(session)
    session.query = (compiled) => {
      observed.push(compiled)
      return originalQuery(compiled)
    }

    return session
  }

  const db = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [],
    operationSessionProvider: controls.provider,
  })

  try {
    const compiled = { sql, params }
    const result = db.execute(compiled)
    expectTypeOf(result).toEqualTypeOf<Promise<unknown[]>>()
    expect(await result).toEqual(rows)
    expect(observed).toEqual([compiled])
    expect(observed[0]).toBe(compiled)
    expect(await db.execute({ sql: 'select 1 where false', params: [] })).toEqual([])
  } finally {
    await db.close()
  }
})

it.each(['column', 'client'] as const)(
  'does not repeat %s parameter mapping or decode builder results',
  async (kind) => {
    const mapParam = vi.fn<(value: unknown) => string>(
      (value) => `stored:${String(value)}`,
    )

    const mapResult = vi.fn<() => string>(() => 'decoded')
    const Value = defineTable(
      'raw_values',
      {
        id: pipe(
          string(),
          column({
            physicalType: { postgresql: 'text' },
            ...(kind === 'column' ? { mapParam, mapResult } : {}),
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    const raw = [{ id: 'stored:value' }]
    const connector = createMockPostgresConnector({ rowsBySql: () => raw })
    const db = createDatabase({
      connector,
      schemas: [Value],
      ...(kind === 'client'
        ? {
            map: {
              mapParamValue: (_type: string, value: unknown) => mapParam(value),
              mapResultValue: mapResult,
            },
          }
        : {}),
    })

    try {
      const compiled = db.from(Value).where(Value.id, 'eq', 'value').compile()
      expect(compiled.params).toEqual(['stored:value'])
      expect(mapParam).toHaveBeenCalledTimes(1)
      const result = db.execute(compiled)
      expectTypeOf(result).toEqualTypeOf<Promise<unknown[]>>()
      expect(await result).toEqual(raw)
      expect(mapParam).toHaveBeenCalledTimes(1)
      expect(mapResult).not.toHaveBeenCalled()
      expect(connector.binds.at(-1)).toEqual(['stored:value'])
    } finally {
      await db.close()
    }
  },
)

it.each(['root', 'transaction'] as const)(
  'runs %s session guards before SQL and preserves guard failures',
  async (scope) => {
    const { db, controls } = controlled()
    const failure = new QueryError({ message: 'wrong session' })
    const guard = vi.fn<NonNullable<CompiledQuery['assertSession']>>()
    const rejectingGuard = vi.fn<NonNullable<CompiledQuery['assertSession']>>(() => {
      throw failure
    })

    const execute = async (client: Db) => {
      await client.execute({ sql: 'accepted', params: [], assertSession: guard })

      await expect(
        client.execute({ sql: 'rejected', params: [], assertSession: rejectingGuard }),
      ).rejects.toBe(failure)
    }

    try {
      if (scope === 'root') await execute(db)
      else await db.transaction(execute)

      expect(guard).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          database: 'coordinator_test',
          physicalSession: 'physical-1',
        }),
      )

      expect(rejectingGuard).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          database: 'coordinator_test',
          physicalSession: scope === 'root' ? 'physical-2' : 'physical-1',
        }),
      )

      expect(controls.calls.some(({ sql }) => sql === 'rejected')).toBe(false)
    } finally {
      await db.close()
    }
  },
)

it('retains a real builder database guard on the compiled object', async () => {
  const Value = defineTable(
    'raw_values',
    { id: string() },
    {
      primaryKey: 'id',
      namespace: [
        { role: 'database', spelling: 'other' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  )

  const connector = createMockPostgresConnector({ database: 'test' })
  const db = createDatabase({ connector, schemas: [Value] })
  try {
    const compiled = db.from(Value).compile()
    await expect(db.execute(compiled)).rejects.toThrow(QueryError)
    expect(connector.prepared).not.toContain(compiled.sql)
  } finally {
    await db.close()
  }
})

it('lets callers validate results and exposes validation failures outside execution', async () => {
  const { db } = controlled({ queryRows: () => [{ value: 1 }] })
  try {
    const rows = await db.execute({ sql: 'select 1 as value', params: [] })
    expect(parse(array(object({ value: number() })), rows)).toEqual([{ value: 1 }])
    expect(() => parse(array(object({ value: string() })), rows)).toThrow(/Invalid type/)

    await expect(db.execute({ sql: 'select 1 as value', params: [] })).resolves.toEqual(
      rows,
    )
  } finally {
    await db.close()
  }
})

it('executes root calls FIFO and drains accepted work before closing', async () => {
  const started = deferred()
  const finish = deferred()
  const { db, controls } = controlled({
    beforeCall: async (_session, sql) => {
      if (sql === 'first') {
        started.resolve()
        await finish.promise
      }
    },
  })

  const first = db.execute({ sql: 'first', params: [] })
  await started.promise
  const second = db.execute({ sql: 'second', params: [] })
  const closing = db.close()

  try {
    expect(controls.calls.map(({ sql }) => sql)).toEqual(['first'])
    expect(controls.closeCount).toBe(0)
    await expect(db.execute({ sql: 'late', params: [] })).rejects.toThrow(QueryError)
  } finally {
    finish.resolve()
  }

  await Promise.all([first, second, closing])
  expect(controls.calls.map(({ sql }) => sql)).toEqual(['first', 'second'])
  expect(controls.closeCount).toBe(1)
  await expect(db.execute({ sql: 'closed', params: [] })).rejects.toThrow(QueryError)
})

it('reuses one transaction session and enforces nested and expired scope ownership', async () => {
  const { db, controls } = controlled()
  let expired!: Db
  try {
    await db.transaction(async (trx) => {
      expired = trx

      await expect(db.execute({ sql: 'root misuse', params: [] })).rejects.toThrow(
        /scoped client/i,
      )

      await Promise.all([
        trx.execute({ sql: 'one', params: [] }),
        trx.execute({ sql: 'two', params: [] }),
      ])

      await trx.transaction(async (nested) => {
        await expect(trx.execute({ sql: 'ancestor misuse', params: [] })).rejects.toThrow(
          /nested callback client/i,
        )

        await nested.execute({ sql: 'three', params: [] })
      })
    })

    await expect(expired.execute({ sql: 'expired', params: [] })).rejects.toThrow(
      /no longer active/i,
    )

    expect(controls.openCount).toBe(1)
    expect(controls.maxActiveCalls).toBe(1)

    expect(controls.calls).toEqual(
      [
        'begin',
        'one',
        'two',
        'savepoint sp_1',
        'three',
        'release savepoint sp_1',
        'commit',
      ].map((sql) => ({ session: 1, sql })),
    )
  } finally {
    await db.close()
  }
})

it('preserves native driver error classification and cause', async () => {
  const failure = Object.assign(new Error('duplicate'), {
    code: '23505',
    constraint: 'users_pkey',
  })

  const connector = createMockPostgresConnector({
    onPrepare: () => {
      throw failure
    },
  })

  const db = createDatabase({ connector, schemas: [] })
  try {
    const result = db.execute({ sql: 'insert into users values ($1)', params: [1] })
    await expect(result).rejects.toBeInstanceOf(DriverError)

    await expect(result).rejects.toMatchObject({
      code: '23505',
      kind: 'uniqueViolation',
      cause: failure,
    })
  } finally {
    await db.close()
  }
})

it.each([new Error('provider defect'), { defect: 'unexpected object' }])(
  'preserves unexpected provider failure identity: %s',
  async (failure) => {
    const stack = Object.getOwnPropertyDescriptor(failure, 'stack')
    const { db } = controlled({
      beforeCall: async () => {
        throw failure
      },
    })

    try {
      await expect(db.execute({ sql: 'select defect', params: [] })).rejects.toBe(failure)

      expect(Object.getOwnPropertyDescriptor(failure, 'stack')).toEqual(stack)
    } finally {
      await db.close()
    }
  },
)
