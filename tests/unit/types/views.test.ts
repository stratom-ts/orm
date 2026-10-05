import {
  boolean,
  date,
  exactOptional,
  integer,
  maxLength,
  maxValue,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  title,
  undefinedable,
} from 'valibot'
import { describe, expectTypeOf, it } from 'vitest'

import type {
  DatabaseDefault,
  InferInsert,
  InferSelect,
  InferSelectedColumns,
  InferUpdate,
  TableIdentityOf,
} from '@/index'
import { column, defineTable, table } from '@/index'

const User = defineTable(
  'users',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
    email: pipe(string(), column({ physicalType: { postgresql: 'varchar(255)' } })),
    age: nullable(pipe(number(), column({ physicalType: { postgresql: 'integer' } }))),
    bio: optional(
      pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: '' },
        }),
      ),
    ),
    active: pipe(
      boolean(),
      column({
        physicalType: { postgresql: 'boolean' },
        databaseDefault: { kind: 'literal', value: true },
      }),
    ),
  },
  { primaryKey: 'id' },
)

const NestedWrappers = defineTable(
  'nested_wrappers',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    optionalNullable: optional(
      nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
    nullableOptional: nullable(
      optional(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
    exactOptional: exactOptional(
      pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: '' },
        }),
      ),
    ),
    undefinedable: undefinedable(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    nonOptionalNullableOptional: nonOptional(
      nullable(
        optional(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
      ),
    ),
    nonNullableOptionalNullable: nonNullable(
      optional(
        nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
      ),
    ),
    nonNullishNullableOptional: nonNullish(
      nullable(
        optional(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
      ),
    ),
  },
  { primaryKey: 'id' },
)

describe('InferSelect', () => {
  it('should return full row types with SQL nullability rules', () => {
    type Row = InferSelect<typeof User>

    expectTypeOf<Row['id']>().toEqualTypeOf<number>()
    expectTypeOf<Row['email']>().toEqualTypeOf<string>()
    expectTypeOf<Row['age']>().toEqualTypeOf<number | null>()

    // optional → NOT NULL in SQL; select is non-null
    expectTypeOf<Row['bio']>().toEqualTypeOf<string>()
    expectTypeOf<Row['active']>().toEqualTypeOf<boolean>()
  })

  it('should preserve nested wrapper nullability regardless of order', () => {
    type Row = InferSelect<typeof NestedWrappers>
    expectTypeOf<Row['optionalNullable']>().toEqualTypeOf<string | null>()
    expectTypeOf<Row['nullableOptional']>().toEqualTypeOf<string | null>()
    expectTypeOf<Row['exactOptional']>().toEqualTypeOf<string>()
    expectTypeOf<Row['undefinedable']>().toEqualTypeOf<string>()
    expectTypeOf<Row['nonOptionalNullableOptional']>().toEqualTypeOf<string | null>()
    expectTypeOf<Row['nonNullableOptionalNullable']>().toEqualTypeOf<string>()
    expectTypeOf<Row['nonNullishNullableOptional']>().toEqualTypeOf<string>()
  })
})

describe('InferSelectedColumns', () => {
  it('should narrow to only the selected column keys as required fields', () => {
    type Row = InferSelectedColumns<
      typeof User,
      readonly [typeof User.id, typeof User.email]
    >

    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
    expectTypeOf<Row>().not.toEqualTypeOf<Partial<{ id: number; email: string }>>()

    expectTypeOf<Row>().not.toHaveProperty('age')
    expectTypeOf<Row>().not.toHaveProperty('bio')
    expectTypeOf<Row>().not.toHaveProperty('active')
  })

  it('should preserve select-view nullability for selected columns', () => {
    type Row = InferSelectedColumns<
      typeof User,
      readonly [typeof User.age, typeof User.bio]
    >

    expectTypeOf<Row>().toEqualTypeOf<{ age: number | null; bio: string }>()
  })

  it('should support string column names', () => {
    type Row = InferSelectedColumns<typeof User, readonly ['id', 'email']>
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
  })

  it('should type columns not on the source table as unknown for bare strings', () => {
    type Row = InferSelectedColumns<typeof User, readonly [typeof User.id, 'missing']>
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; missing: unknown }>()
  })
})

describe('InferSelectedColumns: should resolve cross-table ColumnRefs from the ref payload', () => {
  it('should resolve cross-table ColumnRefs from the ref payload', () => {
    const Post = defineTable(
      'posts',
      {
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        title: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
        authorId: pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
      },
      { primaryKey: 'id' },
    )

    type Row = InferSelectedColumns<
      typeof Post,
      readonly [typeof Post.title, typeof User.email, typeof User.age]
    >

    expectTypeOf<Row>().toEqualTypeOf<{
      title: string
      email: string
      age: number | null
    }>()
  })
})

describe('InferSelectedColumns: should widen outer-join nullable tables with | null', () => {
  it('should widen outer-join nullable tables with | null', () => {
    const Post = defineTable(
      'posts',
      {
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        title: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id' },
    )

    type Row = InferSelectedColumns<
      typeof Post,
      readonly [typeof Post.title, typeof User.email],
      'users'
    >

    expectTypeOf<Row>().toEqualTypeOf<{
      title: string
      email: string | null
    }>()
  })
})

describe('InferSelectedColumns: should distinguish same-named tables by ordered namespace intent', () => {
  it('should distinguish same-named tables by ordered namespace intent', () => {
    const NumericItem = defineTable(
      'items',
      {
        id: pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
      },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'numeric' }],
      },
    )

    const TextItem = defineTable(
      'items',
      {
        label: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      {
        primaryKey: 'label',
        namespace: [{ role: 'database', spelling: 'textual' }],
      },
    )

    type Row = InferSelectedColumns<
      typeof NumericItem,
      readonly [typeof NumericItem.id, typeof TextItem.label],
      TableIdentityOf<typeof TextItem>
    >

    expectTypeOf<Row>().toEqualTypeOf<{
      id: number
      label: string | null
    }>()
  })
})

describe('InferInsert', () => {
  it('should preserve nested wrapper omission and nullability regardless of order', () => {
    type Insert = InferInsert<typeof NestedWrappers>

    expectTypeOf<Insert>().toEqualTypeOf<{
      id: string
      optionalNullable?: string | null
      nullableOptional?: string | null
      exactOptional?: string
      undefinedable: string
      nonOptionalNullableOptional: string | null
      nonNullableOptionalNullable: string
      nonNullishNullableOptional: string
    }>()
  })

  it('should make generated byDefault and defaulted columns optional', () => {
    type Insert = InferInsert<typeof User>

    expectTypeOf<Insert['email']>().toEqualTypeOf<string>()
    expectTypeOf<Insert['age']>().toEqualTypeOf<number | null>()
    expectTypeOf<Insert['id']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Insert['bio']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Insert['active']>().toEqualTypeOf<boolean | undefined>()
  })
})

describe('InferInsert: should only make defined database defaults optional', () => {
  it('should only make defined database defaults optional', () => {
    const Tagged = defineTable(
      'tagged_defaults',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
        value: pipe(
          string(),
          column({ databaseDefault: { kind: 'literal', value: 'ready' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    /** Defines a table whose value column has the supplied optional database default. */
    const withMaybeDefault = (databaseDefault: DatabaseDefault | undefined) =>
      defineTable(
        'maybe_defaults',
        {
          id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
          value: pipe(string(), column({ databaseDefault })),
        },
        { primaryKey: 'id' },
      )

    type TaggedInsert = InferInsert<typeof Tagged>
    type MaybeInsert = InferInsert<ReturnType<typeof withMaybeDefault>>
    expectTypeOf<TaggedInsert['value']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<MaybeInsert['value']>().toEqualTypeOf<string>()
  })
})

describe('InferInsert: should omit generated always columns', () => {
  it('should omit generated always columns', () => {
    const Schema = pipe(
      object({
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'always' },
          }),
        ),
        label: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      }),
      title('g'),
      table({ name: 'g', primaryKey: 'id' }),
    )

    type Insert = InferInsert<typeof Schema>

    expectTypeOf<Insert>().toExtend<{ label: string }>()
    expectTypeOf<Insert>().not.toHaveProperty('id')
  })
})

describe('InferInsert: should model identity and computed generation', () => {
  it('should model identity and computed generation', () => {
    const Generated = defineTable(
      'tagged_generated',
      {
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        always: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'always' },
          }),
        ),
        computed: pipe(
          string(),
          column({
            physicalType: { postgresql: 'text' },
            generation: {
              kind: 'computed',
              expression: {
                kind: 'portableExpression',
                expression: 'currentTimestamp',
              },
              storage: 'stored',
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    type Insert = InferInsert<typeof Generated>

    expectTypeOf<Insert['id']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Insert>().not.toHaveProperty('always')
    expectTypeOf<Insert>().not.toHaveProperty('computed')
  })
})

describe('InferUpdate', () => {
  it('should exclude readonly and always-generated on partial patch', () => {
    const Schema = pipe(
      object({
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'always' },
          }),
        ),
        stamp: pipe(
          string(),
          column({ physicalType: { postgresql: 'text' }, readonly: true }),
        ),
        name: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
        age: nullable(
          pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
        ),
      }),
      title('u'),
      table({ name: 'u', primaryKey: 'id' }),
    )

    type Update = InferUpdate<typeof Schema>

    expectTypeOf<Update['name']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Update['age']>().toEqualTypeOf<number | null | undefined>()
    expectTypeOf<Update>().not.toHaveProperty('id')
    expectTypeOf<Update>().not.toHaveProperty('stamp')
  })
})

describe('columns with inferred types (no column() metadata)', () => {
  const Event = defineTable(
    'events',
    {
      id: pipe(string(), maxLength(36)),
      title: pipe(string(), maxLength(120)),
      description: string(),
      attendees: pipe(number(), integer(), minValue(0), maxValue(100000)),
      isPublic: boolean(),
      startsAt: date(),
      endedAt: nullable(date()),
    },
    { primaryKey: 'id' },
  )

  it('should include inferred columns in the select view', () => {
    type Row = InferSelect<typeof Event>

    expectTypeOf<Row['title']>().toEqualTypeOf<string>()
    expectTypeOf<Row['attendees']>().toEqualTypeOf<number>()
    expectTypeOf<Row['isPublic']>().toEqualTypeOf<boolean>()
    expectTypeOf<Row['startsAt']>().toEqualTypeOf<Date>()
    expectTypeOf<Row['endedAt']>().toEqualTypeOf<Date | null>()
  })

  it('should include inferred columns in the insert view (regression: not dropped as generated-always)', () => {
    type Insert = InferInsert<typeof Event>

    expectTypeOf<Insert['id']>().toEqualTypeOf<string>()
    expectTypeOf<Insert['title']>().toEqualTypeOf<string>()
    expectTypeOf<Insert['attendees']>().toEqualTypeOf<number>()
    expectTypeOf<Insert['isPublic']>().toEqualTypeOf<boolean>()
    expectTypeOf<Insert['startsAt']>().toEqualTypeOf<Date>()

    // nullable() → SQL NULL allowed, still required on insert
    expectTypeOf<Insert['endedAt']>().toEqualTypeOf<Date | null>()
  })

  it('should include inferred columns in the update view', () => {
    type Update = InferUpdate<typeof Event>

    expectTypeOf<Update['title']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Update['attendees']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Update['endedAt']>().toEqualTypeOf<Date | null | undefined>()
  })
})

describe('JSON-shaped nested objects', () => {
  it('should keep plain object types for nested objects without reference', () => {
    const Schema = pipe(
      object({
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        payload: pipe(
          object({ key: string(), value: number() }),
          column({ physicalType: { postgresql: 'jsonb' } }),
        ),
      }),
      title('j'),
      table({ name: 'j', primaryKey: 'id' }),
    )

    type Select = InferSelect<typeof Schema>
    type Insert = InferInsert<typeof Schema>
    type Update = InferUpdate<typeof Schema>

    expectTypeOf<Select['payload']>().toEqualTypeOf<{
      key: string
      value: number
    }>()

    expectTypeOf<Insert['payload']>().toEqualTypeOf<{
      key: string
      value: number
    }>()

    expectTypeOf<Update['payload']>().toEqualTypeOf<
      { key: string; value: number } | undefined
    >()
  })
})
