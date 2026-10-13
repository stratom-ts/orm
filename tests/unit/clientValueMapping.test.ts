import { date, pipe, string, unknown } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'
import type { OperationSessionProvider } from '@/operations/operationSession'
import type { CompiledQuery } from '@/query/builder'
import { QueryError } from '@/utils/error'

import { createMockPostgresConnector } from './helpers/nativePostgresClient'

const LedgerEntries = defineTable(
  'ledger_entries',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    recordedAt: pipe(date(), column({ physicalType: { postgresql: 'timestamptz' } })),
    payload: pipe(unknown(), column({ physicalType: { postgresql: 'jsonb' } })),
    note: pipe(
      string(),
      column({
        physicalType: { postgresql: 'text' },
        /** Applies the column parameter override before client mapping. */
        mapParam: (value) => `column-write:${String(value)}`,
        /** Applies the column result override before client mapping. */
        mapResult: (value) => `column-read:${String(value)}`,
      }),
    ),
    source: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

describe('client value mapping', () => {
  it('uses column overrides before client overrides for parameters and results', async () => {
    const recordedAt = new Date('2026-09-10T01:02:03.000Z')
    const entry = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      recordedAt,
      payload: { invoice: 42 },
      note: 'settled',
      source: 'api',
    }

    const connector = createMockPostgresConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => [
        {
          ...entry,
          recordedAt: recordedAt.toISOString(),
          payload: '{"invoice":42}',
        },
      ],
    })

    const db = createDatabase({
      connector,
      schemas: [LedgerEntries],
      map: {
        /** Maps an authored value to its physical SQL parameter representation. */
        mapParamValue: (dataType, value) => ({
          mappedBy: 'client-param',
          dataType,
          value,
        }),
        /** Decodes a native result value using the selected mapping rules. */
        mapResultValue: (dataType, value) => ({
          mappedBy: 'client-result',
          dataType,
          value,
        }),
      },
    })

    const compiled = db.insert(LedgerEntries).values(entry).compile()
    assertMappedParameters(compiled, recordedAt)

    const [row] = await db.from(LedgerEntries).execute()
    assertMappedResults(row, recordedAt)

    await db.close()
  })
})

it('lets result mapping defects reach the caller unchanged', async () => {
  const defect = new TypeError('result mapping failed')
  const originalStack = defect.stack
  const connector = createMockPostgresConnector({
    rowsBySql: () => [{ id: '550e8400-e29b-41d4-a716-446655440000' }],
  })

  const db = createDatabase({
    connector,
    schemas: [LedgerEntries],
    map: {
      mapResultValue: () => {
        throw defect
      },
    },
  })

  const rejection = await db
    .from(LedgerEntries)
    .execute()
    .catch((cause: unknown) => cause)

  expect(rejection).toBe(defect)
  expect((rejection as Error).stack).toBe(originalStack)

  await db.close()
})

it('lets INSERT RETURNING mapping defects reach the caller unchanged', async () => {
  const defect = new TypeError('insert returning mapping failed')
  const originalStack = defect.stack
  const connector = createMockPostgresConnector({
    rowsBySql: () => [{ id: '550e8400-e29b-41d4-a716-446655440000' }],
  })

  const db = createDatabase({
    connector,
    schemas: [LedgerEntries],
    map: {
      mapResultValue: () => {
        throw defect
      },
    },
  })

  const rejection = await db
    .insert(LedgerEntries)
    .values({
      id: '550e8400-e29b-41d4-a716-446655440000',
      recordedAt: new Date('2026-09-10T01:02:03.000Z'),
      payload: {},
      note: 'returning mapping',
      source: 'test',
    })
    .returning([LedgerEntries.id])
    .execute()
    .catch((cause: unknown) => cause)

  expect(rejection).toBe(defect)
  expect((rejection as Error).stack).toBe(originalStack)
  await db.close()
})

it.each(['row', 'statement'] as const)(
  'lets executor TypeErrors reach the caller unchanged for %s queries',
  async (kind) => {
    const defect = new TypeError(`executor ${kind} failed`)
    const originalStack = defect.stack
    const connector = createMockPostgresConnector()
    const operationSessionProvider: OperationSessionProvider = {
      nativeTransactions: true,
      async open() {
        return {
          identity: { database: 'test', physicalSession: 'test-session' },
          async query(query) {
            if (query.sql.includes('ledger_entries')) throw defect

            return []
          },
          async run(query) {
            if (query.sql.includes('ledger_entries')) throw defect
          },
          async cancel() {},
          async release() {},
        }
      },
      async close() {},
    }

    const db = createDatabase({
      connector,
      schemas: [LedgerEntries],
      operationSessionProvider,
    })

    const operation =
      kind === 'row'
        ? db.from(LedgerEntries).execute()
        : db
            .insert(LedgerEntries)
            .values({
              id: '550e8400-e29b-41d4-a716-446655440000',
              recordedAt: new Date('2026-09-10T01:02:03.000Z'),
              payload: {},
              note: 'note',
              source: 'api',
            })
            .execute()

    const rejection = await operation.catch((cause: unknown) => cause)
    expect(rejection).toBe(defect)
    expect((rejection as Error).stack).toBe(originalStack)

    await db.close()
  },
)

it('passes a recognized QueryError from the executor through unchanged', async () => {
  const expected = new QueryError({ message: 'known query failure' })
  const connector = createMockPostgresConnector({
    onPrepare(sql) {
      if (sql.includes('ledger_entries')) throw expected

      return createMockPostgresConnector().prepare(sql)
    },
  })

  const db = createDatabase({ connector, schemas: [LedgerEntries] })

  const rejection = await db
    .from(LedgerEntries)
    .execute()
    .catch((cause: unknown) => cause)

  expect(rejection).toBe(expected)
  expect(rejection).not.toHaveProperty('defect')
  await db.close()
})

describe('client value mapping: uses dialect defaults when no client override exists', () => {
  it('uses dialect defaults when no client override exists', async () => {
    const recordedAt = new Date('2026-09-10T01:02:03.000Z')
    const entry = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      recordedAt,
      payload: { invoice: 42 },
      note: 'settled',
      source: 'api',
    }

    const connector = createMockPostgresConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => [
        {
          ...entry,
          recordedAt: recordedAt.toISOString(),
          payload: '{"invoice":42}',
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [LedgerEntries] })

    const compiled = db.insert(LedgerEntries).values(entry).compile()
    expect(compiled.params).toContain(recordedAt.toISOString())
    expect(compiled.params).toContain('{"invoice":42}')

    const [row] = await db.from(LedgerEntries).execute()
    expect(row!.recordedAt).toEqual(recordedAt)
    expect(row!.payload).toEqual({ invoice: 42 })
    await db.close()
  })
})

describe('client value mapping: uses dialect defaults when no client override exists: passes through unmapped values and preserves nulls', () => {
  it('passes through unmapped values and preserves nulls', async () => {
    const connector = createMockPostgresConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => [
        {
          id: null,
          recordedAt: null,
          payload: null,
          note: 'settled',
          source: 'worker',
          driverExtra: 17,
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [LedgerEntries] })

    const [row] = await db.from(LedgerEntries).execute()
    expect(row).toEqual({
      id: null,
      recordedAt: null,
      payload: null,
      note: 'column-read:settled',
      source: 'worker',
      driverExtra: 17,
    })

    await db.close()
  })
})

describe('client value mapping: returns invalid timestamp and JSON text unchanged instead of inventing values', () => {
  it('returns invalid timestamp and JSON text unchanged instead of inventing values', async () => {
    const connector = createMockPostgresConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          recordedAt: 'not-a-date',
          payload: '{not-json}',
          note: 'settled',
          source: 'api',
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [LedgerEntries] })

    const [row] = await db.from(LedgerEntries).execute()
    expect(row!.recordedAt).toBe('not-a-date')
    expect(row!.payload).toBe('{not-json}')
    await db.close()
  })

  it('preserves non-object driver rows instead of coercing them into records', async () => {
    const rows = [null, 'count', 7, ['tuple']]
    const connector = createMockPostgresConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => rows,
    })

    const db = createDatabase({ connector, schemas: [LedgerEntries] })

    await expect(db.from(LedgerEntries).execute()).resolves.toEqual(rows)
    await db.close()
  })
})

/**
 * Checks column override precedence and client result mappings across physical SQL types.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param recordedAt - Authored timestamp used to compare mapped query results.
 */
function assertMappedResults(
  row: { id: string; recordedAt: Date; payload: unknown; note: string; source: string },
  recordedAt: Date,
) {
  expect(row!.note).toBe('column-read:settled')

  expect(row!.recordedAt).toEqual({
    mappedBy: 'client-result',
    dataType: 'timestamptz',
    value: recordedAt.toISOString(),
  })

  expect(row!.payload).toEqual({
    mappedBy: 'client-result',
    dataType: 'jsonb',
    value: '{"invoice":42}',
  })

  expect(row!.source).toEqual({
    mappedBy: 'client-result',
    dataType: 'text',
    value: 'api',
  })
}

/**
 * Checks column override precedence and client parameter mappings before query
 * compilation.
 *
 * @param compiled - Compiled SQL, bound parameters, and optional session preconditions.
 * @param recordedAt - Authored timestamp used to compare mapped query results.
 */
function assertMappedParameters(compiled: CompiledQuery, recordedAt: Date) {
  expect(compiled.params).toContain('column-write:settled')

  expect(compiled.params).toContainEqual({
    mappedBy: 'client-param',
    dataType: 'timestamptz',
    value: recordedAt,
  })

  expect(compiled.params).toContainEqual({
    mappedBy: 'client-param',
    dataType: 'jsonb',
    value: { invoice: 42 },
  })

  expect(compiled.params).toContainEqual({
    mappedBy: 'client-param',
    dataType: 'text',
    value: 'api',
  })
}
