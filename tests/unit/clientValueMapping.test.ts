import {
  bigint,
  date,
  decimal,
  ip,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  literal,
  mac48,
  mac64,
  nullable,
  number,
  object,
  picklist,
  pipe,
  safeInteger,
  safeParse,
  string,
  toDate,
  toString,
  transform,
  union,
  unknown,
  uuid,
} from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { postgresDialect } from '@/dialects/postgres/dialect'
import { sqliteDialect } from '@/dialects/sqlite/dialect'
import { SchemaError, column, createDatabase, defineTable, reference } from '@/index'
import type { OperationSessionProvider } from '@/operations/operationSession'
import type { CompiledQuery } from '@/query/builder'
import { createValueMapper } from '@/query/mapping'
import { QueryError } from '@/utils/error'

import { createMockPostgresConnector } from './dialects/postgresNativeClientFixtures'

/** Defines the independent hook-direction fixtures shared by accepted/rejected cases. */
function hookFixture(
  columnParam: boolean,
  columnResult: boolean,
  clientParam: boolean,
  clientResult: boolean,
) {
  const Hooked = defineTable(
    'hook_matrix',
    {
      value: pipe(
        number(),
        column({
          physicalType: { postgresql: 'text', sqlite: 'TEXT' },
          ...(columnParam ? { mapParam: () => 'column-write' } : {}),
          ...(columnResult ? { mapResult: () => 11 } : {}),
        }),
      ),
    },
    { primaryKey: 'value' },
  )

  const map = {
    ...(clientParam ? { mapParamValue: () => 'client-write' } : {}),
    ...(clientResult ? { mapResultValue: () => 22 } : {}),
  }

  return { Hooked, map }
}

it.each([
  ['none', false, false, false, false],
  ['column parameter only', true, false, false, false],
  ['column result only', false, true, false, false],
  ['client parameter only', false, false, true, false],
  ['client result only', false, false, false, true],
] as const)(
  'should reject O02 %s hooks in both dialects',
  (_name, columnParam, columnResult, clientParam, clientResult) => {
    const { Hooked, map } = hookFixture(
      columnParam,
      columnResult,
      clientParam,
      clientResult,
    )

    for (const dialect of [postgresDialect, sqliteDialect])
      expect(() => createValueMapper(dialect, map, [Hooked])).toThrow(SchemaError)
  },
)

it.each([
  ['paired column', true, true, false, false],
  ['paired client', false, false, true, true],
  ['column parameter and client result', true, false, false, true],
  ['client parameter and column result', false, true, true, false],
  ['column precedence both directions', true, true, true, true],
] as const)(
  'should apply O02 %s hooks in both dialects',
  (_name, columnParam, columnResult, clientParam, clientResult) => {
    const { Hooked, map } = hookFixture(
      columnParam,
      columnResult,
      clientParam,
      clientResult,
    )

    for (const dialect of [postgresDialect, sqliteDialect]) {
      const mapper = createValueMapper(dialect, map, [Hooked])
      expect(mapper.mapParam(Hooked, 'value', 42)).toBe(
        columnParam ? 'column-write' : 'client-write',
      )

      expect(mapper.mapResultValue(Hooked, 'value', '42')).toBe(columnResult ? 11 : 22)
    }
  },
)

const Native = defineTable(
  'native_values',
  {
    id: pipe(string(), ip()),
    shortMac: pipe(string(), mac48()),
    longMac: pipe(string(), mac64()),
    amount: nullable(pipe(string(), decimal())),
  },
  { primaryKey: 'id' },
)

const row = {
  id: '192.0.2.1',
  shortMac: 'ab:cd:ef:12:34:56',
  longMac: 'ab:cd:ef:12:34:56:78:90',
  amount: '12345678901234567890.1200',
}

/** Defines serial overrides with one paired column mapping for precedence checks. */
function serialPrecedenceTable(type: string) {
  return defineTable(
    'serial_precedence',
    {
      id: string(),
      builtin: pipe(
        bigint(),
        column({ physicalType: { postgresql: type, sqlite: 'TEXT' } }),
      ),
      hooked: pipe(
        bigint(),
        column({
          physicalType: { postgresql: type, sqlite: 'TEXT' },
          mapParam: (value) => String(BigInt(String(value)) + 1n),
          mapResult: (value) => BigInt(String(value)) + 1n,
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

it.each(['smallserial', 'serial', 'bigserial'])(
  'should use selected %s storage and column hooks before built-in mapping',
  async (type) => {
    const Serial = serialPrecedenceTable(type)
    const raw = { id: 'one', builtin: type === 'bigserial' ? '42' : 42, hooked: '42' }
    const input = { id: 'one', builtin: 42n, hooked: 42n }
    const db = createDatabase({
      connector: createMockPostgresConnector({ rowsBySql: () => [raw] }),
      schemas: [Serial],
    })

    expect(db.insert(Serial).values(input).compile().params).toEqual(['one', '42', '43'])
    expect(await db.from(Serial).execute()).toEqual([{ ...input, hooked: 43n }])
    await db.close()
  },
)

it.each(['smallserial', 'serial', 'bigserial'])(
  'should pass authored %s storage to client hooks after column hooks',
  async (type) => {
    const Serial = serialPrecedenceTable(type)
    const raw = { id: 'one', builtin: type === 'bigserial' ? '42' : 42, hooked: '42' }
    const input = { id: 'one', builtin: 42n, hooked: 42n }
    const paramTypes: string[] = []
    const resultTypes: string[] = []
    const mapped = createDatabase({
      connector: createMockPostgresConnector({ rowsBySql: () => [raw] }),
      schemas: [Serial],
      map: {
        mapParamValue(dataType, value) {
          paramTypes.push(dataType)
          return dataType === type ? String(BigInt(String(value)) + 2n) : value
        },
        mapResultValue(dataType, value) {
          resultTypes.push(dataType)
          return dataType === type ? BigInt(String(value)) + 2n : value
        },
      },
    })

    expect(mapped.insert(Serial).values(input).compile().params).toEqual([
      'one',
      '44',
      '43',
    ])

    expect(await mapped.from(Serial).execute()).toEqual([
      { ...input, builtin: 44n, hooked: 43n },
    ])

    expect(paramTypes).toEqual(['text', type])
    expect(resultTypes).toEqual(['text', type])
    await mapped.close()
  },
)

it('should reject conflicting inference at client creation before connector access', () => {
  const Conflict = defineTable(
    'native_conflict',
    {
      id: pipe(string(), mac48(), mac64()),
    },
    { primaryKey: 'id' },
  )

  const connector = createMockPostgresConnector()
  const getInstance = vi.spyOn(connector, 'getInstance')
  const prepare = vi.spyOn(connector, 'prepare')
  expect(() => createDatabase({ connector, schemas: [Conflict] })).toThrow(SchemaError)
  expect(getInstance).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})

it('should require both mapping directions for a mixed composite with selected storage', async () => {
  const Mixed = defineTable(
    'mixed_composite',
    {
      id: string(),
      value: pipe(
        union([string(), number()]),
        column({ physicalType: { postgresql: 'text' } }),
      ),
    },
    { primaryKey: 'id' },
  )

  const connector = createMockPostgresConnector()
  const getInstance = vi.spyOn(connector, 'getInstance')

  expect(() => createDatabase({ connector, schemas: [Mixed] })).toThrow(SchemaError)
  expect(getInstance).not.toHaveBeenCalled()

  const Mapped = defineTable(
    'mapped_composite',
    {
      id: string(),
      value: pipe(
        union([string(), number()]),
        column({
          physicalType: { postgresql: 'text' },
          mapParam: (value) => JSON.stringify(value),
          mapResult: (value) => JSON.parse(String(value)) as string | number,
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({ connector, schemas: [Mapped] })
  expect(db.insert(Mapped).values({ id: 'one', value: 42 }).compile().params).toEqual([
    'one',
    '42',
  ])

  await db.close()
})

it('should reject unsafe JSON composites before connector access', () => {
  const schema = pipe(
    union([object({ at: date() }), object({ at: date() })]),
    column({ physicalType: { postgresql: 'jsonb' } }),
  )

  const Invalid = defineTable(
    'unsafe_json_composite',
    { id: string(), value: schema },
    {
      primaryKey: 'id',
    },
  )

  const rejectedConnector = createMockPostgresConnector()
  const getInstance = vi.spyOn(rejectedConnector, 'getInstance')
  const prepare = vi.spyOn(rejectedConnector, 'prepare')

  expect(() =>
    createDatabase({ connector: rejectedConnector, schemas: [Invalid] }),
  ).toThrow(/JSON composite output is not preserved/)

  expect(getInstance).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()

  expect(() =>
    createDatabase({
      connector: createMockPostgresConnector(),
      schemas: [Invalid],
      map: { mapParamValue: (_type, item) => JSON.stringify(item) },
    }),
  ).toThrow(/JSON composite output is not preserved/)
})

it('should allow paired client hooks to preserve nested Date output', async () => {
  const schema = pipe(
    union([object({ at: date() }), object({ at: date() })]),
    column({ physicalType: { postgresql: 'jsonb' } }),
  )

  const value = { at: new Date('2026-01-01T00:00:00Z') }
  const Mapped = defineTable(
    'mapped_unsafe_json_composite',
    { id: string(), value: schema },
    {
      primaryKey: 'id',
    },
  )

  const db = createDatabase({
    connector: createMockPostgresConnector({
      rowsBySql: () => [{ id: 'one', value: { at: '2026-01-01T00:00:00.000Z' } }],
    }),
    schemas: [Mapped],
    map: {
      mapParamValue: (type, item) =>
        type === 'jsonb'
          ? JSON.stringify({ at: (item as typeof value).at.toISOString() })
          : item,
      mapResultValue: (type, item) => {
        if (type !== 'jsonb') return item

        const parsed: unknown = typeof item === 'string' ? JSON.parse(item) : item
        return { at: new Date((parsed as { at: string }).at) }
      },
    },
  })

  expect(db.insert(Mapped).values({ id: 'one', value }).compile().params).toEqual([
    'one',
    '{"at":"2026-01-01T00:00:00.000Z"}',
  ])

  await expect(db.from(Mapped).execute()).resolves.toEqual([{ id: 'one', value }])
  await db.close()
})

it('should use inferred jsonb and built-in mappings after nested conversion', async () => {
  const branch = pipe(object({ at: date() }), object({ at: pipe(date(), toString()) }))
  const Recovered = defineTable(
    'recovered_json_composite',
    { id: string(), value: union([branch, branch]) },
    { primaryKey: 'id' },
  )

  const at = new Date('2026-01-01T00:00:00.000Z')
  const output = { id: 'one', value: { at: at.toString() } }
  const db = createDatabase({
    connector: createMockPostgresConnector({ rowsBySql: () => [output] }),
    schemas: [Recovered],
  })

  expect(
    db.insert(Recovered).values({ id: 'one', value: { at } }).compile().params,
  ).toEqual(['one', JSON.stringify(output.value)])

  await expect(db.from(Recovered).execute()).resolves.toEqual([output])
  await db.close()
})

it('should reject lossy selected composite storage before connector access', () => {
  const Lossy = defineTable(
    'lossy_composite',
    {
      id: string(),
      value: pipe(
        union([bigint(), literal(1n)]),
        column({ physicalType: { postgresql: 'double precision' } }),
      ),
    },
    { primaryKey: 'id' },
  )

  const connector = createMockPostgresConnector()
  const getInstance = vi.spyOn(connector, 'getInstance')

  expect(() => createDatabase({ connector, schemas: [Lossy] })).toThrow(SchemaError)
  expect(getInstance).not.toHaveBeenCalled()
})

it('should require a selected PostgreSQL override for mixed choices at client creation', async () => {
  const Unrelated = defineTable(
    'unrelated_choice',
    { id: pipe(picklist(['one', 1]), column({ physicalType: { sqlite: 'TEXT' } })) },
    { primaryKey: 'id' },
  )

  const connector = createMockPostgresConnector()
  const getInstance = vi.spyOn(connector, 'getInstance')
  expect(() => createDatabase({ connector, schemas: [Unrelated] })).toThrow(SchemaError)
  expect(getInstance).not.toHaveBeenCalled()

  const Selected = defineTable(
    'selected_choice',
    {
      id: pipe(
        picklist(['one', 1]),
        column({
          physicalType: { postgresql: 'text' },
          mapParam: (value) => String(value),
          mapResult: (value) => (value === '1' ? 1 : 'one'),
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  expect(() =>
    createDatabase({
      connector,
      schemas: [
        defineTable(
          'unmapped_choice',
          {
            id: pipe(
              picklist(['one', 1]),
              column({ physicalType: { postgresql: 'text' } }),
            ),
          },
          { primaryKey: 'id' },
        ),
      ],
    }),
  ).toThrow(SchemaError)

  const db = createDatabase({ connector, schemas: [Selected] })
  expect(db.insert(Selected).values({ id: 'one' }).compile().params).toEqual(['one'])
  await db.close()
})

it('should preserve native numeric strings and pass selected storage to mapping hooks', async () => {
  const connector = createMockPostgresConnector({
    rowsBySql: () => [row, { ...row, amount: null }],
  })

  const db = createDatabase({ connector, schemas: [Native] })
  expect(db.insert(Native).values(row).compile().params).toEqual(Object.values(row))
  expect(await db.from(Native).execute()).toEqual([row, { ...row, amount: null }])
  await db.close()

  const seen: string[] = []
  const mapped = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Native],
    map: {
      mapParamValue(type, value) {
        seen.push(type)
        return value
      },
    },
  })

  mapped.insert(Native).values(row).compile()
  expect(seen).toEqual(['inet', 'macaddr', 'macaddr8', 'numeric'])
  await mapped.close()
})

it('should pass numeric schema context through writes, predicates, and result mapping', async () => {
  const Numbers = defineTable(
    'mapped_numbers',
    {
      id: string(),
      exact: bigint(),
      safe: pipe(number(), safeInteger()),
      decimalText: pipe(string(), decimal()),
    },
    { primaryKey: 'id' },
  )

  const connector = createMockPostgresConnector({
    rowsBySql: () => [
      {
        id: 'row',
        exact: '9223372036854775808',
        safe: '9007199254740991',
        decimalText: '12345678901234567890.125',
      },
    ],
  })

  const db = createDatabase({ connector, schemas: [Numbers] })
  const row = {
    id: 'row',
    exact: 9223372036854775808n,
    safe: Number.MAX_SAFE_INTEGER,
    decimalText: '12345678901234567890.125',
  }

  expect(db.insert(Numbers).values(row).compile().params).toEqual([
    row.id,
    row.exact.toString(),
    row.safe,
    row.decimalText,
  ])

  expect(db.from(Numbers).where({ exact: row.exact }).compile().params).toEqual([
    row.exact.toString(),
  ])

  expect(db.from(Numbers).where({ safe: row.safe }).compile().params).toEqual([row.safe])
  expect(await db.from(Numbers).execute()).toEqual([row])
  await db.close()
})

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

const InferredUuidParent = defineTable(
  'inferred_uuid_parent',
  { id: pipe(string(), uuid()) },
  { primaryKey: 'id' },
)

const InferredUuidChild = defineTable(
  'inferred_uuid_child',
  {
    id: string(),
    parentId: reference(InferredUuidParent, 'id'),
    nullableParentId: nullable(reference(InferredUuidParent, 'id')),
  },
  { primaryKey: 'id' },
)

describe('inferred UUID client value mapping', () => {
  it('should compile supplied UUID strings and preserve native UUID strings and null results', async () => {
    const parentId = '550e8400-e29b-41d4-a716-446655440000'
    const row = { id: 'child', parentId, nullableParentId: null }
    const connector = createMockPostgresConnector({ rowsBySql: () => [row] })
    const db = createDatabase({
      connector,
      schemas: [InferredUuidParent, InferredUuidChild],
    })

    const compiled = db.insert(InferredUuidChild).values(row).compile()
    expect(compiled.params).toContain(parentId)
    expect(compiled.params).toContain(null)
    expect(await db.from(InferredUuidChild).execute()).toEqual([row])
    await db.close()
  })
})

describe('inferred UUID client mapping overrides', () => {
  it('should pass inferred and inherited UUID storage to client mapping overrides', async () => {
    const parentId = '550e8400-e29b-41d4-a716-446655440000'
    const connector = createMockPostgresConnector({
      rowsBySql: () => [{ id: 'child', parentId, nullableParentId: null }],
    })

    const seen: { direction: string; dataType: string; value: unknown }[] = []
    const db = createDatabase({
      connector,
      schemas: [InferredUuidParent, InferredUuidChild],
      map: {
        mapParamValue(dataType, value) {
          seen.push({ direction: 'param', dataType, value })
          return value
        },
        mapResultValue(dataType, value) {
          seen.push({ direction: 'result', dataType, value })
          return value
        },
      },
    })

    expect(
      db.insert(InferredUuidParent).values({ id: parentId }).compile().params,
    ).toContain(parentId)

    expect(seen).toContainEqual({ direction: 'param', dataType: 'uuid', value: parentId })
    seen.length = 0

    expect(
      db
        .insert(InferredUuidChild)
        .values({ id: 'child', parentId, nullableParentId: null })
        .compile().params,
    ).toContain(parentId)

    expect(seen).toContainEqual({ direction: 'param', dataType: 'uuid', value: parentId })
    expect(seen).toContainEqual({ direction: 'param', dataType: 'uuid', value: null })
    seen.length = 0

    expect(await db.from(InferredUuidChild).execute()).toEqual([
      { id: 'child', parentId, nullableParentId: null },
    ])

    expect(seen).toContainEqual({
      direction: 'result',
      dataType: 'uuid',
      value: parentId,
    })

    expect(seen).toContainEqual({ direction: 'result', dataType: 'uuid', value: null })
    await db.close()
  })
})

describe('client value mapping', () => {
  it('should use column overrides before client overrides for parameters and results', async () => {
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

it('should let result mapping defects reach the caller unchanged', async () => {
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

it('should let INSERT RETURNING mapping defects reach the caller unchanged', async () => {
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
  'should let executor TypeErrors reach the caller unchanged for %s queries',
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

it('should classify a native QueryError as DriverError while retaining its cause', async () => {
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

  expect(rejection).toMatchObject({
    _tag: 'DriverError',
    dialect: 'postgresql',
    cause: expected,
  })

  expect(rejection).not.toHaveProperty('defect')
  await db.close()
})

describe('client value mapping: uses dialect defaults when no client override exists', () => {
  it('should use dialect defaults when no client override exists', async () => {
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
  it('should pass through unmapped values and preserve nulls', async () => {
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
  it('should return invalid timestamp and JSON text unchanged instead of inventing values', async () => {
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

  it('should preserve non-object driver rows instead of coercing them into records', async () => {
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

it.each([
  [isoTime(), isoTimeSecond(), '03:04', '03:04:00'],
  [isoDateTime(), isoDateTimeSecond(), '2026-01-02T03:04', '2026-01-02 03:04:00'],
])(
  'should preserve authored temporal reference output on select and explicit returning',
  async (minute, second, input, raw) => {
    const Parent = defineTable(
      'temporal_parent',
      { value: pipe(string(), minute) },
      { primaryKey: 'value' },
    )

    const writeTransform = vi.fn<(value: string) => string>((value) => `${value}:00`)
    const Child = defineTable(
      'temporal_child',
      {
        value: pipe(
          reference(Parent, 'value'),
          transform(writeTransform),
          string(),
          second,
        ),
        matching: reference(Parent, 'value'),
      },
      { primaryKey: 'value' },
    )

    const expected = { value: `${input}:00`, matching: input }
    const connector = createMockPostgresConnector({
      rowsBySql: (sql) =>
        sql.includes('"temporal_parent"')
          ? [{ value: raw }]
          : [{ value: raw, matching: raw }],
    })

    const db = createDatabase({ connector, schemas: [Parent, Child] })
    try {
      const insert = db.insert(Child).values({ value: input, matching: input })
      expect(insert.compile().params).toEqual([expected.value, input])
      expect(writeTransform).toHaveBeenCalledWith(input)
      const writes = writeTransform.mock.calls.length
      expect(await db.from(Child).execute()).toEqual([expected])
      expect(writeTransform).toHaveBeenCalledTimes(writes)
      expect(await db.from(Parent).execute()).toEqual([{ value: input }])
      const returned = await insert
        .returning([Child.value, Child.matching])
        .executeTakeFirstOrThrow()

      expect(returned).toEqual(expected)
      expect(safeParse(pipe(string(), second), returned.value).success).toBe(true)
      expect(safeParse(pipe(string(), minute), returned.matching).success).toBe(true)
      expect(writeTransform).toHaveBeenCalledTimes(writes)
      expect(connector.binds).toContainEqual([expected.value, input])
    } finally {
      await db.close()
    }
  },
)

it.each(['native family', 'ambiguous precision', 'Date output'])(
  'should reject unsupported reference %s before connector access or SQL preparation',
  (scenario) => {
    const Parent = defineTable(
      'temporal_parent',
      { value: pipe(string(), scenario === 'Date output' ? isoTimestamp() : isoTime()) },
      { primaryKey: 'value' },
    )

    const incompatible = pipe(
      reference(Parent, 'value'),
      transform((value) => `2026-01-02T${value}:00`),
      string(),
      isoDateTimeSecond(),
    )

    const Child = defineTable(
      'temporal_child',
      {
        value:
          scenario === 'native family'
            ? incompatible
            : scenario === 'Date output'
              ? pipe(reference(Parent, 'value'), toDate())
              : pipe(reference(Parent, 'value'), isoTimeSecond()),
      },
      { primaryKey: 'value' },
    )

    const connector = createMockPostgresConnector()
    const getInstance = vi.spyOn(connector, 'getInstance')
    const prepare = vi.spyOn(connector, 'prepare')

    expect(() => createDatabase({ connector, schemas: [Parent, Child] })).toThrow(
      SchemaError,
    )

    expect(() => createDatabase({ connector, schemas: [Parent, Child] })).toThrow(
      /paired column mapParam\/mapResult or client mapParamValue\/mapResultValue/,
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  },
)

it.each([postgresDialect, sqliteDialect])(
  'identifies the relation and column in $id inference failures',
  (dialect) => {
    const Issues = defineTable(
      'issues',
      {
        id: string(),
        title: pipe(
          string(),
          transform((value) => value),
        ),
      },
      { primaryKey: 'id' },
    )

    expect(() => createValueMapper(dialect, undefined, [Issues])).toThrow(
      /Column "title" in \[relation:"issues"\]: cannot infer .*unresolved transformation/,
    )
  },
)

it('preserves unexpected inference defects by identity', async () => {
  const defect = new Error('inference defect')
  const Issues = defineTable('issues', { id: string() }, { primaryKey: 'id' })
  const dialect = {
    ...postgresDialect,
    schema: {
      ...postgresDialect.schema,
      inferColumnType() {
        throw defect
      },
    },
  }

  await expect(async () => createValueMapper(dialect, undefined, [Issues])).rejects.toBe(
    defect,
  )
})
