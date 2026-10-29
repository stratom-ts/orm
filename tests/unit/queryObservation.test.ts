import { pipe, string } from 'valibot'
import { expect, it, vi } from 'vitest'

import type { CreateDatabaseConfig, QueryEvent } from '@/index'
import { column, createDatabase, defineTable } from '@/index'
import { markCompiledQuery } from '@/query/compiled'

import { deferred } from '../helpers/deferredPromise'

import { createPostgresControllableProvider } from './dialects/postgresOperationSessionFixtures'
import {
  createControllableProvider,
  customConnector,
  withDeadline,
} from './helpers/operationSessionFixtures'

const Item = defineTable(
  'observed_items',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id' },
)

/** Builds a public client backed by controlled physical sessions. */
function controlled(
  config: Partial<CreateDatabaseConfig> = {},
  options?: Parameters<typeof createControllableProvider>[0],
) {
  const controls = createControllableProvider(options)
  const events: QueryEvent[] = []
  const db = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [Item],
    operationSessionProvider: controls.provider,
    onQuery: (event) => {
      events.push(event)
    },
    ...config,
  })

  return { db, controls, events }
}

it('observes raw, builder SELECT and DML exactly once with redacted ordered bindings', async () => {
  const { db, events, controls } = controlled()
  try {
    const compiled = db.from(Item).where(Item.id, 'eq', 'secret').compile()
    expect(events).toEqual([])
    await db.execute(compiled)
    await db.from(Item).where(Item.id, 'eq', 'other').execute()
    await db.insert(Item).values({ id: 'inserted' }).execute()
    await db.sql`select ${'raw'}, ${null}`
    expect(events).toHaveLength(4)
    expect(events.map((e) => e.sql)).toEqual(controls.calls.map((c) => c.sql))
    expect(events.map((e) => e.source)).toEqual(['query', 'query', 'query', 'query'])

    expect(events.map((e) => e.params)).toEqual([
      ['[REDACTED]'],
      ['[REDACTED]'],
      ['[REDACTED]'],
      ['[REDACTED]', '[REDACTED]'],
    ])

    expect(events.every((e) => e.outcome === 'success' && e.durationMs >= 0)).toBe(true)
  } finally {
    await db.close()
  }
})

it('snapshots and freezes included bindings without mutating the original array', async () => {
  const events: QueryEvent[] = []
  const { db } = controlled({
    queryParameters: 'include',
    onQuery: (event) => {
      events.push(event)
      Reflect.set(event.params, '0', 'changed')
    },
  })

  try {
    const compiled = db.sql.fragment`select ${'first'}, ${2}`
    await db.execute(compiled)
    expect(Object.isFrozen(events[0])).toBe(true)
    expect(Object.isFrozen(events[0]?.params)).toBe(true)
    expect(events[0]?.params).toEqual(['first', 2])
    expect(events[0]?.params).not.toBe(compiled.params)
    expect(compiled.params).toEqual(['first', 2])
  } finally {
    await db.close()
  }
})

it('attributes transaction and savepoint control and ping to lifecycle', async () => {
  const { db, events } = controlled()
  try {
    await db.transaction(async (trx) => {
      await trx.ping()

      await expect(
        trx.transaction(async (nested) => {
          await nested.sql`select 2`
          throw 'rollback child'
        }),
      ).rejects.toBe('rollback child')

      await trx.sql`select 3`
    })

    expect(events.map((e) => e.source)).toEqual([
      'lifecycle',
      'lifecycle',
      'lifecycle',
      'query',
      'lifecycle',
      'lifecycle',
      'query',
      'lifecycle',
    ])

    expect(events.map((e) => e.sql)).toEqual(
      expect.arrayContaining(['begin', 'commit', 'select 2', 'select 3']),
    )
  } finally {
    await db.close()
  }
})

it.each([new Error('defect'), 'primitive', Object.freeze({ code: '23505' })])(
  'retains the original boundary failure in error events: %s',
  async (failure) => {
    const { db, events } = controlled(
      {},
      {
        beforeCall: async () => {
          throw failure
        },
      },
    )

    try {
      await expect(db.sql`select 1`).rejects.toBeDefined()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ outcome: 'error', source: 'query' })
      expect(events[0]?.outcome === 'error' && events[0].error).toBe(failure)
    } finally {
      await db.close()
    }
  },
)

it.each(['sync', 'async'] as const)(
  'contains %s observer failures on success and failure',
  async (kind) => {
    const failure = new Error('query failure')
    const observer = vi.fn<() => void | Promise<void>>(() => {
      if (kind === 'sync') throw new Error('observer')

      return Promise.reject(new Error('observer'))
    })

    const { db } = controlled(
      { onQuery: observer },
      {
        beforeCall: async (_session, sql) => {
          if (sql === 'bad') throw failure
        },
      },
    )

    try {
      await expect(db.sql`select 1`).resolves.toEqual([])
      await expect(db.execute(db.sql.fragment`bad`)).rejects.toBe(failure)
      expect(observer).toHaveBeenCalledTimes(2)
    } finally {
      await db.close()
    }
  },
)

it('does not await observers during operations or close', async () => {
  const pending = deferred()
  const { db, controls } = controlled({ onQuery: () => pending.promise })
  try {
    await withDeadline(db.ping())
    await withDeadline(db.close())
    expect(controls.closeCount).toBe(1)
  } finally {
    pending.resolve()
    await db.close()
  }
})

it('does not observe guard or closed-client rejections', async () => {
  const { db, events } = controlled()
  try {
    const query = markCompiledQuery({
      ...db.sql.fragment`select 1`,
      assertSession: () => {
        throw new Error('guard')
      },
    })

    await expect(db.execute(query)).rejects.toThrow('guard')
    expect(events).toEqual([])
  } finally {
    await db.close()
  }

  await expect(db.ping()).rejects.toThrow('closed')
  expect(events).toEqual([])
})

it('excludes coordinator queue wait from duration', async () => {
  const entered = deferred()
  const finish = deferred()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  const { db, events } = controlled(
    {},
    {
      beforeCall: async (_s, sql) => {
        if (sql === 'select 1') {
          entered.resolve()
          await finish.promise
        }
      },
    },
  )

  try {
    const first = db.sql`select 1`
    await entered.promise
    const second = db.sql`select 2`
    clock.mockReturnValue(1000)
    finish.resolve()
    await Promise.all([first, second])
    expect(events.map((e) => e.durationMs)).toEqual([1000, 0])
  } finally {
    finish.resolve()
    clock.mockRestore()
    await db.close()
  }
})

it.each([false, true])(
  'observes migration catalog, locks, lifecycle and DDL with failure=%s',
  async (fail) => {
    const failure = new Error('DDL rejected')
    const controls = createPostgresControllableProvider({
      beforeCall: async (_s, sql) => {
        if (fail && sql.startsWith('create table')) throw failure
      },
    })

    const events: QueryEvent[] = []
    const db = createDatabase({
      connector: customConnector('postgresql'),
      schemas: [Item],
      operationSessionProvider: controls.provider,
      onQuery: (e) => {
        events.push(e)
      },
    })

    try {
      const result = await db
        .migrate()
        .execute()
        .then(
          () => 'success',
          () => 'error',
        )

      expect(result).toBe(fail ? 'error' : 'success')

      expect(events.filter((e) => e.source === 'catalog').length).toBeGreaterThan(0)

      expect(events.find((e) => e.sql.includes('pg_try_advisory_lock'))?.source).toBe(
        'coordination',
      )

      expect(events.find((e) => e.sql.startsWith('begin'))?.source).toBe('lifecycle')
      const ddl = events.find((e) => e.sql.startsWith('create table'))
      expect(ddl?.source).toBe('ddl')
      expect(ddl?.outcome).toBe(fail ? 'error' : 'success')

      expect(ddl?.outcome === 'error' ? ddl.error : undefined).toBe(
        fail ? failure : undefined,
      )

      expect(events.map((e) => e.sql)).toEqual(controls.calls.map((c) => c.sql))
    } finally {
      await db.close()
    }
  },
)

it('reports cancellation rejection at the physical lock boundary', async () => {
  const started = deferred()
  let rejectPending!: (cause: unknown) => void
  const pending = new Promise<void>((_resolve, reject) => {
    rejectPending = reject
  })

  const failure = new Error('native cancelled')
  const events: QueryEvent[] = []
  const controls = createPostgresControllableProvider({
    beforeCall: async (_session, sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        started.resolve()
        await pending
      }
    },
    beforeCancel: async () => {
      rejectPending(failure)
    },
  })

  const db = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [],
    operationSessionProvider: controls.provider,
    onQuery: (e) => {
      events.push(e)
    },
  })

  try {
    const controller = new AbortController()
    const migration = db.migrate().execute({ signal: controller.signal })
    await started.promise
    controller.abort()
    await expect(migration).rejects.toMatchObject({ stage: 'lock' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ source: 'coordination', outcome: 'error' })
    expect(events[0]?.outcome === 'error' && events[0].error).toBe(failure)
  } finally {
    rejectPending(failure)
    await db.close()
  }
})

it('does not emit SQL events for migration aborted before execution', async () => {
  const { db, events } = controlled()
  try {
    const controller = new AbortController()
    controller.abort()

    await expect(
      db.migrate().execute({ signal: controller.signal }),
    ).rejects.toMatchObject({ stage: 'lock' })

    expect(events).toEqual([])
  } finally {
    await db.close()
  }
})

it.each(['plan', 'dryRun'] as const)(
  'attributes %s catalog SQL without observing compilation as DDL',
  async (method) => {
    const events: QueryEvent[] = []
    const controls = createPostgresControllableProvider()
    const db = createDatabase({
      connector: customConnector('postgresql'),
      schemas: [Item],
      operationSessionProvider: controls.provider,
      onQuery: (event) => {
        events.push(event)
      },
    })

    try {
      await db.migrate()[method]()
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((event) => event.source === 'catalog')).toBe(true)

      expect(events.map((event) => event.sql)).toEqual(
        controls.calls.map((call) => call.sql),
      )
    } finally {
      await db.close()
    }
  },
)
