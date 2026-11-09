import { tracingChannel } from 'node:diagnostics_channel'
import { pipe, string } from 'valibot'
import { expect, it, onTestFinished, vi } from 'vitest'

import type { QueryEvent, TracingOptions } from '@/index'
import { QUERY_CHANNEL, column, createDatabase, defineTable, withTracing } from '@/index'
import { markCompiledQuery } from '@/query/compiled'

import { deferred } from '../helpers/deferredPromise'

import { createPostgresControllableProvider } from './dialects/postgresOperationSessionFixtures'
import {
  createControllableProvider,
  customConnector,
} from './helpers/operationSessionFixtures'

const Item = defineTable(
  'observed_items',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id' },
)

function observe(callback: (event: QueryEvent) => void) {
  const channel = tracingChannel(QUERY_CHANNEL)
  const subscribers = { asyncEnd: (event: unknown) => callback(event as QueryEvent) }
  channel.subscribe(subscribers)
  onTestFinished(() => channel.unsubscribe(subscribers))
}

/** Builds a public client backed by controlled physical sessions. */
function controlled(
  config: TracingOptions = {},
  options?: Parameters<typeof createControllableProvider>[0],
) {
  const controls = createControllableProvider(options)
  const events: QueryEvent[] = []
  const original = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [Item],
    operationSessionProvider: controls.provider,
  })

  observe((event) => events.push(event))
  const db = withTracing(original, config)
  return { db, original, controls, events }
}

it('should observe raw, builder SELECT and DML exactly once with redacted ordered bindings', async () => {
  const { db, events, controls } = controlled()
  try {
    const compiled = db.from(Item).where(Item.id, 'eq', 'secret').compile()
    expect(events).toEqual([])
    await db.execute(compiled)
    await db.from(Item).where(Item.id, 'eq', 'other').execute()
    await db.insert(Item).values({ id: 'inserted' }).execute()
    await db.sql`select ${'raw'}, ${null}`
    expect(events).toHaveLength(4)
    expect(events.map((e) => e.query)).toEqual(controls.calls.map((c) => c.sql))
    expect(events.map((e) => e.source)).toEqual(['query', 'query', 'query', 'query'])

    expect(events.map((e) => e.params)).toEqual([
      ['[REDACTED]'],
      ['[REDACTED]'],
      ['[REDACTED]'],
      ['[REDACTED]', '[REDACTED]'],
    ])

    expect(
      events.every((e) => e.outcome === 'success' && (e.durationMs ?? -1) >= 0),
    ).toBe(true)
  } finally {
    await db.close()
  }
})

it('should snapshot included bindings without mutating the original array', async () => {
  const { db, events } = controlled({ queryParameters: 'include' })
  try {
    const compiled = db.sql.fragment`select ${'first'}, ${2}`
    await db.execute(compiled)
    expect(Object.isFrozen(events[0]?.params)).toBe(true)
    expect(events[0]?.params).toEqual(['first', 2])
    expect(events[0]?.params).not.toBe(compiled.params)
    expect(compiled.params).toEqual(['first', 2])
    expect(events[0]).not.toHaveProperty('result', expect.anything())
  } finally {
    await db.close()
  }
})

it('should attribute transaction and savepoint control and ping to lifecycle', async () => {
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

    expect(events.map((e) => e.query)).toEqual(
      expect.arrayContaining(['begin', 'commit', 'select 2', 'select 3']),
    )
  } finally {
    await db.close()
  }
})

it.each([new Error('defect'), 'primitive', Object.freeze({ code: '23505' })])(
  'should retain the original boundary failure in error events: %s',
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

it('should not observe guard or closed-client rejections', async () => {
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

it('should exclude coordinator queue wait from duration', async () => {
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
  'should observe migration catalog, locks, lifecycle and DDL with failure=%s',
  async (fail) => {
    const failure = new Error('DDL rejected')
    const controls = createPostgresControllableProvider({
      beforeCall: async (_s, sql) => {
        if (fail && sql.startsWith('create table')) throw failure
      },
    })

    const events: QueryEvent[] = []
    const db = withTracing(
      createDatabase({
        connector: customConnector('postgresql'),
        schemas: [Item],
        operationSessionProvider: controls.provider,
      }),
    )

    observe((event) => events.push(event))

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

      expect(events.find((e) => e.query.includes('pg_try_advisory_lock'))?.source).toBe(
        'coordination',
      )

      expect(events.find((e) => e.query.startsWith('begin'))?.source).toBe('lifecycle')
      const ddl = events.find((e) => e.query.startsWith('create table'))
      expect(ddl?.source).toBe('ddl')
      expect(ddl?.outcome).toBe(fail ? 'error' : 'success')

      expect(ddl?.outcome === 'error' ? ddl.error : undefined).toBe(
        fail ? failure : undefined,
      )

      expect(events.map((e) => e.query)).toEqual(controls.calls.map((c) => c.sql))
    } finally {
      await db.close()
    }
  },
)

it('should report cancellation rejection at the physical lock boundary', async () => {
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

  const db = withTracing(
    createDatabase({
      connector: customConnector('postgresql'),
      schemas: [],
      operationSessionProvider: controls.provider,
    }),
  )

  observe((event) => events.push(event))

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

it('should not emit SQL events for migration aborted before execution', async () => {
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
  'should attribute %s catalog SQL without observing compilation as DDL',
  async (method) => {
    const events: QueryEvent[] = []
    const controls = createPostgresControllableProvider()
    const db = withTracing(
      createDatabase({
        connector: customConnector('postgresql'),
        schemas: [Item],
        operationSessionProvider: controls.provider,
      }),
    )

    observe((event) => events.push(event))

    try {
      await db.migrate()[method]()
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((event) => event.source === 'catalog')).toBe(true)

      expect(events.map((event) => event.query)).toEqual(
        controls.calls.map((call) => call.sql),
      )
    } finally {
      await db.close()
    }
  },
)

it('should isolate lazy and interleaved calls across original, wrappers and unrelated clients', async () => {
  const { db, original, events } = controlled()
  const included = withTracing(original, { queryParameters: 'include' })
  const otherControls = createControllableProvider()
  const other = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [Item],
    operationSessionProvider: otherControls.provider,
  })

  try {
    expect(withTracing(db, { queryParameters: 'include' })).toBe(db)
    expect(db.schemas).toBe(original.schemas)
    const plainBuilder = original.from(Item).where(Item.id, 'eq', 'plain')
    const tracedBuilder = db.from(Item).where(Item.id, 'eq', 'traced')
    expect(events).toEqual([])

    await Promise.all([
      plainBuilder.execute(),
      tracedBuilder.execute(),
      original.sql`select ${'hidden'}`,
      included.sql`select ${'visible'}`,
      other.ping(),
    ])

    expect(events.map((event) => event.params)).toEqual([['[REDACTED]'], ['visible']])
  } finally {
    await original.close()
    await other.close()
  }
})

it.each([false, true])(
  'should publish one ordered lifecycle without result rows, failure=%s',
  async (fail) => {
    const failure = new Error('physical failure')
    const { db, events } = controlled(
      {},
      {
        beforeCall: async () => {
          if (fail) throw failure
        },
      },
    )

    const order: string[] = []
    const contexts: unknown[] = []
    const channel = tracingChannel(QUERY_CHANNEL)

    const record = (name: string) => (event: unknown) => {
      order.push(name)
      contexts.push(event)
    }

    const subscribers = {
      start: record('start'),
      end: record('end'),
      error: record('error'),
      asyncStart: record('asyncStart'),
      asyncEnd: record('asyncEnd'),
    }

    channel.subscribe(subscribers)

    try {
      const settled = await db.sql`select 1`.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )

      expect(settled).toEqual(fail ? { error: failure } : { value: [] })

      expect(order).toEqual(
        fail
          ? ['start', 'end', 'error', 'asyncStart', 'asyncEnd']
          : ['start', 'end', 'asyncStart', 'asyncEnd'],
      )

      expect(contexts.every((context) => context === events[0])).toBe(true)
      expect(events).toHaveLength(1)
      expect(events[0]?.error).toBe(fail ? failure : undefined)
      expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
      expect(Reflect.get(events[0], 'result')).toBeUndefined()
    } finally {
      channel.unsubscribe(subscribers)
      await db.close()
    }
  },
)

it('should keep root and ancestor guards and scoped lifetime', async () => {
  const { db, original, events } = controlled()
  let expired: typeof db | undefined
  try {
    await db.transaction(async (trx) => {
      expect(withTracing(trx)).toBe(trx)
      expired = trx
      await expect(original.ping()).rejects.toThrow('root database client')
      await expect(db.ping()).rejects.toThrow('root database client')
      await expect(trx.close()).rejects.toThrow('Transaction clients cannot close')

      await trx.transaction(async (nested) => {
        await expect(trx.ping()).rejects.toThrow('ancestor transaction')
        await nested.ping()
      })
    })

    const count = events.length
    await expect(expired!.ping()).rejects.toThrow('no longer active')
    expect(events).toHaveLength(count)
  } finally {
    await db.close()
  }
})

it('should drain traced queries and session release before closing the shared provider', async () => {
  const entered = deferred()
  const finishQuery = deferred()
  const releasing = deferred()
  const finishRelease = deferred()
  const { db, original, controls } = controlled(
    {},
    {
      beforeCall: async (_session, sql) => {
        if (sql === 'select 5') {
          entered.resolve()
          await finishQuery.promise
        }
      },
      beforeRelease: async () => {
        releasing.resolve()
        await finishRelease.promise
      },
    },
  )

  try {
    const pending = db.sql`select 5`
    await entered.promise
    const close = original.close()

    // Let runnable close work proceed while the physical query remains gated.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(controls.closeCount).toBe(0)

    finishQuery.resolve()
    await releasing.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(controls.closeCount).toBe(0)

    finishRelease.resolve()
    await Promise.all([pending, close])
    await db.close()
    expect(controls.closeCount).toBe(1)

    expect(controls.events).toEqual([
      'lease-opened:1',
      'statement:1:select 5',
      'release-started:1:reuse',
      'release-finished:1:reuse',
      'provider-closed',
    ])

    await expect(db.ping()).rejects.toThrow('closed')
  } finally {
    finishQuery.resolve()
    finishRelease.resolve()
    await db.close()
  }
})

it('should trace an existing transaction view without enabling its original view', async () => {
  const { original, events } = controlled()
  try {
    await original.transaction(async (trx) => {
      const traced = withTracing(trx)
      await trx.ping()
      expect(events).toEqual([])

      await traced.transaction(async (nested) => {
        await nested.ping()
      })

      expect(events.map((event) => event.source)).toEqual([
        'lifecycle',
        'lifecycle',
        'lifecycle',
      ])

      await trx.ping()
      expect(events).toHaveLength(3)
    })

    expect(events).toHaveLength(3)
  } finally {
    await original.close()
  }
})

it('should not trace calls initiated through the original by a subscriber', async () => {
  const { db, original, events } = controlled()
  let attempted: Promise<void> | undefined
  const channel = tracingChannel(QUERY_CHANNEL)
  const subscribers = {
    start: () => {
      attempted = original.ping()
    },
  }

  channel.subscribe(subscribers)

  try {
    await db.ping()
    await expect(attempted).rejects.toThrow('root database client')
    expect(events).toHaveLength(1)
  } finally {
    channel.unsubscribe(subscribers)
    await db.close()
  }
})

it('should return the original client when tracing channels are unavailable', async () => {
  const { original } = controlled()
  const lookup = vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
  try {
    expect(withTracing(original)).toBe(original)
  } finally {
    lookup.mockRestore()
    await original.close()
  }
})

it('should do no parameter snapshot or timing work without subscribers', async () => {
  const controls = createControllableProvider()
  const original = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [],
    operationSessionProvider: controls.provider,
  })

  const db = withTracing(original)
  const params = ['secret']
  const snapshot = vi.spyOn(params, 'map')
  const clock = vi.spyOn(performance, 'now')
  try {
    const query = markCompiledQuery({ sql: 'select $1', params })
    await original.execute(query)
    await db.execute(query)
    expect(snapshot).not.toHaveBeenCalled()
    expect(clock).not.toHaveBeenCalled()
  } finally {
    snapshot.mockRestore()
    clock.mockRestore()
    await db.close()
  }
})

it('should do no tracing work through the original client with active subscribers', async () => {
  const { original, events } = controlled()
  const params = ['secret']
  const snapshot = vi.spyOn(params, 'map')
  const clock = vi.spyOn(performance, 'now')
  try {
    const query = markCompiledQuery({ sql: 'select $1', params })
    await original.execute(query)
    expect(events).toEqual([])
    expect(snapshot).not.toHaveBeenCalled()
    expect(clock).not.toHaveBeenCalled()
  } finally {
    snapshot.mockRestore()
    clock.mockRestore()
    await original.close()
  }
})

it('should exclude synchronous lifecycle subscriber work from physical duration', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  const { db, events } = controlled()
  const channel = tracingChannel(QUERY_CHANNEL)
  const subscribers = {
    start: () => clock.mockReturnValue(100),
    end: () => clock.mockReturnValue(200),
    asyncStart: () => clock.mockReturnValue(300),
  }

  channel.subscribe(subscribers)

  try {
    await db.ping()
    expect(events[0]?.durationMs).toBe(0)
  } finally {
    clock.mockRestore()
    channel.unsubscribe(subscribers)
    await db.close()
  }
})
