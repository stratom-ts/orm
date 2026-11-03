import {
  bigint,
  boolean,
  isoTime,
  maxValue,
  minValue,
  number,
  object,
  optional,
  picklist,
  pipe,
  safeInteger,
  string,
  transform,
  union,
} from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { registerDesiredSchema } from '@/ddl/desiredSchema'
import {
  column,
  createDatabase,
  defineTable,
  postgresDialect,
  reference,
  sqliteDialect,
} from '@/index'
import type { CanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { createValueMapper } from '@/query/mapping'
import type { AnySchema } from '@/types/schema'
import { SchemaError, attemptSync } from '@/utils/error'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

import { createMockPostgresConnector } from './postgresNativeClientFixtures'

const profiles = [
  {
    key: 'postgresql',
    dialect: postgresDialect,
    connector: createMockPostgresConnector,
    namespace: [
      { role: 'database', spelling: 'test' },
      { role: 'schema', spelling: 'public' },
    ],
    incompatibleType: 'text',
    loweredOverride: {
      ok: false,
      error: { _tag: 'MigrationError', cause: { _tag: 'SchemaError' } },
    },
  },
  {
    key: 'sqlite',
    dialect: sqliteDialect,
    connector: () => customConnector('sqlite'),
    namespace: [{ role: 'database', spelling: 'main' }],
    incompatibleType: 'TEXT',
    loweredOverride: {
      ok: true,
      value: { tables: [{ columns: [{ dataType: 'TEXT' }] }] },
    },
  },
] as const

type StorageCase = {
  name: string
  schema: AnySchema
  physicalType?: { postgresql: string; sqlite: string }
  type: { postgresql: string; sqlite: string }
  value: unknown
  stored: { postgresql: unknown; sqlite: unknown }
}

const cases: StorageCase[] = [
  {
    name: 'numeric choice widens its integer storage',
    schema: picklist([1, 2147483648]),
    type: { postgresql: 'bigint', sqlite: 'INTEGER' },
    value: 2147483648,
    stored: { postgresql: 2147483648, sqlite: 2147483648 },
  },
  {
    name: 'composite numbers widen to fractional storage',
    schema: union([pipe(number(), safeInteger()), number()]),
    type: { postgresql: 'double precision', sqlite: 'REAL' },
    value: 1.25,
    stored: { postgresql: 1.25, sqlite: 1.25 },
  },
  {
    name: 'bounded bigint retains its logical output',
    schema: pipe(bigint(), minValue(0n), maxValue(100n)),
    type: { postgresql: 'bigint', sqlite: 'BIGINT' },
    value: 42n,
    stored: { postgresql: '42', sqlite: 42n },
  },
  {
    name: 'JSON uses serialization rather than physical affinity',
    schema: object({ count: number() }),
    physicalType: { postgresql: 'json', sqlite: 'BLOB' },
    type: { postgresql: 'json', sqlite: 'BLOB' },
    value: { count: 2 },
    stored: { postgresql: '{"count":2}', sqlite: '{"count":2}' },
  },
  {
    name: 'serial and integer overrides keep logical number conversion',
    schema: pipe(number(), safeInteger()),
    physicalType: { postgresql: 'bigserial', sqlite: 'INTEGER' },
    type: { postgresql: 'bigserial', sqlite: 'INTEGER' },
    value: 42,
    stored: { postgresql: 42, sqlite: 42 },
  },
]

type StorageProfile = (typeof profiles)[number]

function registerStorageCases(
  profile: StorageProfile,
  identities: CanonicalRelationIdentityModule,
) {
  const { dialect } = profile

  it.each(cases)('$name in query construction, mapping and desired lowering', (item) => {
    const Records = defineTable(
      'storage_records',
      {
        value: pipe(item.schema, column({ physicalType: item.physicalType })),
      },
      { primaryKey: 'value' },
    )

    const graph = registerDesiredSchema([Records], identities)
    const lowered = dialect.schema.lowerDesiredSchema(graph)
    const mapper = createValueMapper(dialect, undefined, [Records])
    const db = createDatabase({
      connector: profile.connector(),
      operationSessionProvider: createControllableProvider().provider,
      schemas: [Records],
    })

    expect(lowered.tables[0]?.columns[0]?.dataType).toBe(item.type[profile.key])
    expect(mapper.columnTypes(Records)).toEqual({ value: item.type[profile.key] })

    expect(db.insert(Records).values({ value: item.value }).compile().params).toEqual([
      item.stored[profile.key],
    ])

    expect(mapper.mapResultValue(Records, 'value', item.stored[profile.key])).toEqual(
      item.value,
    )
  })
}

function registerUnpairedHooks(
  profile: StorageProfile,
  identities: CanonicalRelationIdentityModule,
) {
  const { dialect } = profile

  it.each([
    'none',
    'column parameter',
    'column result',
    'client parameter',
    'client result',
  ])('keeps built-in checks with %s custom mapping', (direction) => {
    const hook = vi.fn<(value: unknown) => unknown>((value) => value)
    const Records = defineTable(
      'incompatible_records',
      {
        value: pipe(
          boolean(),
          column({
            physicalType: { [dialect.id]: profile.incompatibleType },
            ...(direction === 'column parameter' ? { mapParam: hook } : {}),
            ...(direction === 'column result' ? { mapResult: hook } : {}),
          }),
        ),
      },
      { primaryKey: 'value' },
    )

    const map = {
      ...(direction === 'client parameter' ? { mapParamValue: hook } : {}),
      ...(direction === 'client result' ? { mapResultValue: hook } : {}),
    }

    expect(() =>
      createDatabase({
        connector: profile.connector(),
        operationSessionProvider: createControllableProvider().provider,
        schemas: [Records],
        map,
      }),
    ).toThrow(SchemaError)

    const lower = () =>
      dialect.schema.lowerDesiredSchema(registerDesiredSchema([Records], identities), {
        hasGlobalParameterMapping: direction === 'client parameter',
        hasGlobalResultMapping: direction === 'client result',
      })

    expect(attemptSync(lower)).toMatchObject(profile.loweredOverride)
    expect(hook).not.toHaveBeenCalled()
  })
}

function registerPairedHooks(
  profile: StorageProfile,
  identities: CanonicalRelationIdentityModule,
) {
  const { dialect } = profile

  it('uses effective paired hooks across column and client scopes without evaluating schema code', () => {
    const defaultFactory = vi.fn<() => string>(() => 'default')
    const transformation = vi.fn<(value: string) => string>((value) => value)
    const columnParam = vi.fn<() => string>(() => 'column parameter')
    const clientParam = vi.fn<() => string>(() => 'client parameter')
    const clientResult = vi.fn<() => string>(() => 'client result')
    const Records = defineTable(
      'custom_records',
      {
        value: pipe(
          optional(string(), defaultFactory),
          transform(transformation),
          column({
            physicalType: { [dialect.id]: profile.incompatibleType },
            mapParam: columnParam,
          }),
        ),
      },
      { primaryKey: 'value' },
    )

    const map = { mapParamValue: clientParam, mapResultValue: clientResult }
    const lowered = dialect.schema.lowerDesiredSchema(
      registerDesiredSchema([Records], identities),
      { hasGlobalParameterMapping: true, hasGlobalResultMapping: true },
    )

    const mapper = createValueMapper(dialect, map, [Records])

    expect(lowered.tables[0]?.columns[0]?.dataType).toBe(profile.incompatibleType)
    for (const callback of [
      defaultFactory,
      transformation,
      columnParam,
      clientParam,
      clientResult,
    ])
      expect(callback).not.toHaveBeenCalled()

    expect(mapper.mapParam(Records, 'value', 'input')).toBe('column parameter')
    expect(mapper.mapResultValue(Records, 'value', 'stored')).toBe('client result')
    expect(clientParam).not.toHaveBeenCalled()
  })
}

function registerReferenceStorage(
  profile: StorageProfile,
  identities: CanonicalRelationIdentityModule,
) {
  const { dialect } = profile

  it('inherits reference storage while preserving the locally authored temporal output', () => {
    const Parent = defineTable(
      'storage_parent',
      { value: string() },
      { primaryKey: 'value' },
    )

    const Child = defineTable(
      'storage_child',
      { value: pipe(reference(Parent, 'value'), isoTime()) },
      { primaryKey: 'value' },
    )

    const handles = [Parent, Child]
    const lowered = dialect.schema.lowerDesiredSchema(
      registerDesiredSchema(handles, identities),
    )

    const mapper = createValueMapper(dialect, undefined, handles)
    const db = createDatabase({
      connector: profile.connector(),
      operationSessionProvider: createControllableProvider().provider,
      schemas: handles,
    })

    const child = lowered.tables.find(
      (table) => table.identity.relation.spelling === 'storage_child',
    )

    expect(child?.columns[0]?.dataType).toBe(profile.incompatibleType)
    expect(mapper.columnTypes(Child)).toEqual({ value: profile.incompatibleType })

    expect(db.insert(Child).values({ value: '03:04' }).compile().params).toEqual([
      '03:04',
    ])

    expect(mapper.mapResultValue(Child, 'value', '03:04')).toBe('03:04')
  })
}

describe.each(profiles)('$dialect.id storage decisions across callers', (profile) => {
  const identities = profile.dialect.identity.create({
    context: { writableDefault: profile.namespace },
  })

  registerStorageCases(profile, identities)
  registerUnpairedHooks(profile, identities)
  registerPairedHooks(profile, identities)
  registerReferenceStorage(profile, identities)
})
