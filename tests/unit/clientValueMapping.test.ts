import { date, pipe, string, unknown } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'

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
        mapParam: (value) => `column-write:${String(value)}`,
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
        mapParamValue: (dataType, value) => ({
          mappedBy: 'client-param',
          dataType,
          value,
        }),
        mapResultValue: (dataType, value) => ({
          mappedBy: 'client-result',
          dataType,
          value,
        }),
      },
    })

    const compiled = db.insert(LedgerEntries).values(entry).compile()
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

    const [row] = await db.from(LedgerEntries).execute()
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
    await db.close()
  })

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

  it('passes through unmapped values and preserves nulls', async () => {
    const connector = createMockPostgresConnector({
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

  it('returns invalid timestamp and JSON text unchanged instead of inventing values', async () => {
    const connector = createMockPostgresConnector({
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
    const connector = createMockPostgresConnector({ rowsBySql: () => rows })
    const db = createDatabase({ connector, schemas: [LedgerEntries] })

    await expect(db.from(LedgerEntries).execute()).resolves.toEqual(rows)
    await db.close()
  })
})
