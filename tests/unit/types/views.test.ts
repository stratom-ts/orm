import {
  boolean,
  date,
  decimal,
  enum as enumSchema,
  exactOptional,
  integer,
  intersect,
  ip,
  isoDate,
  isoTimestamp,
  literal,
  mac48,
  mac64,
  maxLength,
  maxValue,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  normalize,
  null as nullSchema,
  nullable,
  nullish,
  number,
  object,
  optional,
  picklist,
  pipe,
  string,
  title,
  toBigint,
  toDate,
  toLowerCase,
  toNumber,
  toString,
  transform,
  undefinedable,
  union,
  variant,
} from 'valibot'
import type { InferInput, InferOutput } from 'valibot'
import { describe, expectTypeOf, it } from 'vitest'

import type {
  DatabaseDefault,
  InferInsert,
  InferSelect,
  InferSelectedColumns,
  InferUpdate,
  TableHandle,
  TableIdentityOf,
  TableSchema,
} from '@/index'
import { column, defineTable, reference, table } from '@/index'

describe('temporal schema views', () => {
  it('should keep ISO string and transformed Date outputs distinct', () => {
    const Temporal = defineTable(
      'temporal_views',
      {
        id: pipe(string(), isoDate()),
        instant: nullable(pipe(string(), isoTimestamp())),
        converted: pipe(string(), isoTimestamp(), toDate()),
        nativeDate: date(),
      },
      { primaryKey: 'id' },
    )

    const Reference = defineTable(
      'temporal_view_references',
      { id: string(), temporalId: nullable(reference(Temporal, 'id')) },
      { primaryKey: 'id' },
    )

    expectTypeOf<InferSelect<typeof Temporal>['id']>().toEqualTypeOf<string>()
    expectTypeOf<InferSelect<typeof Temporal>['instant']>().toEqualTypeOf<string | null>()
    expectTypeOf<InferSelect<typeof Temporal>['converted']>().toEqualTypeOf<Date>()
    expectTypeOf<InferSelect<typeof Temporal>['nativeDate']>().toEqualTypeOf<Date>()
    expectTypeOf<InferInsert<typeof Temporal>['converted']>().toEqualTypeOf<string>()

    expectTypeOf<InferUpdate<typeof Temporal>['converted']>().toEqualTypeOf<
      string | undefined
    >()

    expectTypeOf<InferSelect<typeof Reference>['temporalId']>().toEqualTypeOf<
      string | null
    >()
  })
})

describe('should retain native format string row types', () => {
  it('should keep insert, select, update, and reference values as strings', () => {
    const Native = defineTable(
      'native_formats',
      {
        id: pipe(string(), ip()),
        shortMac: pipe(string(), mac48()),
        longMac: pipe(string(), mac64()),
        amount: nullable(pipe(string(), decimal())),
      },
      { primaryKey: 'id' },
    )

    const Child = defineTable(
      'native_format_refs',
      {
        id: string(),
        parentId: nullable(reference(Native, 'id')),
      },
      { primaryKey: 'id' },
    )

    type Row = { id: string; shortMac: string; longMac: string; amount: string | null }
    expectTypeOf<InferInsert<typeof Native>>().toEqualTypeOf<Row>()
    expectTypeOf<InferSelect<typeof Native>>().toEqualTypeOf<Row>()
    expectTypeOf<InferUpdate<typeof Native>>().toEqualTypeOf<Partial<Row>>()
    expectTypeOf<InferSelect<typeof Child>['parentId']>().toEqualTypeOf<string | null>()
    expectTypeOf<InferInsert<typeof Child>['parentId']>().toEqualTypeOf<string | null>()
  })
})

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

const ParsedValue = defineTable(
  'parsed_values',
  { value: pipe(string(), toNumber()) },
  { primaryKey: 'value' },
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

    expectTypeOf<
      InferSelectedColumns<
        typeof User,
        readonly [
          typeof NestedWrappers.optionalNullable,
          typeof NestedWrappers.nonNullableOptionalNullable,
          typeof NestedWrappers.nonNullishNullableOptional,
        ]
      >
    >().toEqualTypeOf<{
      optionalNullable: string | null
      nonNullableOptionalNullable: string
      nonNullishNullableOptional: string
    }>()
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
  it('should carry null unions through insert, update, and select views', () => {
    const Composite = defineTable(
      'composite_views',
      {
        id: string(),
        value: union([string(), nullSchema()]),
        required: nonNullable(union([nullable(string()), nullSchema()])),
      },
      { primaryKey: 'id' },
    )

    expectTypeOf<InferInsert<typeof Composite>['value']>().toEqualTypeOf<string | null>()

    expectTypeOf<InferUpdate<typeof Composite>['value']>().toEqualTypeOf<
      string | null | undefined
    >()

    expectTypeOf<InferSelect<typeof Composite>['value']>().toEqualTypeOf<string | null>()
    expectTypeOf<InferInsert<typeof Composite>['required']>().toEqualTypeOf<string>()
  })

  it('should use a later pipeline schema to remove composite nullability', () => {
    const transformed = pipe(union([string(), nullSchema()]), toString(), string())
    const Recovered = defineTable(
      'recovered_composite_views',
      {
        id: string(),
        value: transformed,
      },
      { primaryKey: 'id' },
    )

    expectTypeOf<InferInput<typeof transformed>>().toEqualTypeOf<string | null>()
    expectTypeOf<InferOutput<typeof transformed>>().toEqualTypeOf<string>()
    expectTypeOf<InferInsert<typeof Recovered>['value']>().toEqualTypeOf<string | null>()

    expectTypeOf<InferUpdate<typeof Recovered>['value']>().toEqualTypeOf<
      string | null | undefined
    >()

    expectTypeOf<InferSelect<typeof Recovered>['value']>().toEqualTypeOf<string>()
  })
})

const compositeNullableDefaultValue = pipe(
  union([nullable(string(), 'fallback'), string()]),
  column({ databaseDefault: { kind: 'literal', value: null } }),
)

const CompositeNullableDefaultRecords = defineTable(
  'composite_nullable_default_views',
  { id: string(), value: compositeNullableDefaultValue },
  { primaryKey: 'id' },
)

const CompositeNullableDefaultReference = defineTable(
  'composite_nullable_default_references',
  { id: string(), value: reference(CompositeNullableDefaultRecords, 'value') },
  { primaryKey: 'id' },
)

const CompositeNullableDefaultRoots = defineTable(
  'composite_nullable_default_roots',
  { id: string() },
  { primaryKey: 'id' },
)

it('should infer defaulted nullable branches in composite read and write views', () => {
  expectTypeOf<
    InferOutput<typeof compositeNullableDefaultValue>
  >().toEqualTypeOf<string>()

  expectTypeOf<InferInput<typeof compositeNullableDefaultValue>>().toEqualTypeOf<
    string | null
  >()

  expectTypeOf<
    InferSelect<typeof CompositeNullableDefaultRecords>['value']
  >().toEqualTypeOf<string | null>()

  expectTypeOf<InferInsert<typeof CompositeNullableDefaultRecords>>().toEqualTypeOf<{
    id: string
    value?: string | null
  }>()

  expectTypeOf<
    InferUpdate<typeof CompositeNullableDefaultRecords>['value']
  >().toEqualTypeOf<string | null | undefined>()

  expectTypeOf<
    InferSelect<typeof CompositeNullableDefaultReference>['value']
  >().toEqualTypeOf<string | null>()
})

it('should preserve composite SQL nullability through cross-table column refs', () => {
  expectTypeOf<typeof CompositeNullableDefaultRecords>().toExtend<
    TableHandle<TableSchema<'composite_nullable_default_views'>>
  >()

  expectTypeOf<
    InferSelectedColumns<
      typeof CompositeNullableDefaultRecords,
      readonly [typeof CompositeNullableDefaultRecords.value]
    >['value']
  >().toEqualTypeOf<string | null>()

  expectTypeOf<
    InferSelectedColumns<
      typeof CompositeNullableDefaultRoots,
      readonly [typeof CompositeNullableDefaultRecords.value]
    >['value']
  >().toEqualTypeOf<string | null>()

  expectTypeOf<
    InferSelectedColumns<
      typeof CompositeNullableDefaultRoots,
      readonly [typeof CompositeNullableDefaultRecords.value],
      TableIdentityOf<typeof CompositeNullableDefaultRecords>
    >['value']
  >().toEqualTypeOf<string | null>()

  expectTypeOf<
    InferSelectedColumns<
      typeof CompositeNullableDefaultRoots,
      readonly [typeof CompositeNullableDefaultReference.value]
    >['value']
  >().toEqualTypeOf<string | null>()
})

it('should preserve composite reversals, transformations, and intersection branch rules', () => {
  const NullableMerged = intersect([
    nullable(string(), 'first'),
    nullable(string(), 'second'),
  ])

  const RequiredMerged = intersect([nullable(string()), string()])

  const NonNullable = nonNullable(union([nullable(string(), 'fallback'), string()]))

  const Converted = pipe(union([nullable(string(), 'fallback'), string()]), toString())

  const MergedTable = defineTable(
    'composite_intersection_views',
    { id: string(), value: NullableMerged },
    { primaryKey: 'id' },
  )

  const RequiredTable = defineTable(
    'composite_reversal_views',
    { id: string(), value: NonNullable },
    { primaryKey: 'id' },
  )

  const ConvertedTable = defineTable(
    'composite_transform_views',
    { id: string(), value: Converted },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferOutput<typeof NullableMerged>>().toEqualTypeOf<string>()
  expectTypeOf<InferSelect<typeof MergedTable>['value']>().toEqualTypeOf<string | null>()

  expectTypeOf<InferOutput<typeof RequiredMerged>>().toEqualTypeOf<string>()
  expectTypeOf<InferSelect<typeof RequiredTable>['value']>().toEqualTypeOf<string>()
  expectTypeOf<InferSelect<typeof ConvertedTable>['value']>().toEqualTypeOf<string>()

  expectTypeOf<
    InferSelectedColumns<
      typeof MergedTable,
      readonly [typeof RequiredTable.value]
    >['value']
  >().toEqualTypeOf<string>()

  expectTypeOf<
    InferSelectedColumns<
      typeof MergedTable,
      readonly [typeof ConvertedTable.value]
    >['value']
  >().toEqualTypeOf<string>()
})

it('should infer SQL nullability from non-tuple composite options', () => {
  const branches = [nullable(string(), 'fallback'), string()]
  const ArrayUnion = defineTable(
    'composite_nullable_array_views',
    { id: string(), value: union(branches) },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferSelect<typeof ArrayUnion>['value']>().toEqualTypeOf<string | null>()
})

it('should keep object variants non-nullable in read views', () => {
  const Variant = defineTable(
    'composite_nullable_variant_views',
    {
      id: string(),
      value: variant('kind', [
        object({ kind: literal('text'), value: string() }),
        object({ kind: literal('count'), value: number() }),
      ]),
    },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferSelect<typeof Variant>['value']>().toEqualTypeOf<
    { kind: 'text'; value: string } | { kind: 'count'; value: number }
  >()
})

it('should keep string write inputs separate from nullable transformed outputs', () => {
  const transformed = pipe(
    string(),
    transform((value): number | null => (value === 'null' ? null : Number(value))),
    nullable(number()),
  )

  const Transformed = defineTable(
    'transformed_nullable_output_views',
    { id: string(), value: transformed },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferInput<typeof transformed>>().toEqualTypeOf<string>()
  expectTypeOf<InferOutput<typeof transformed>>().toEqualTypeOf<number | null>()
  expectTypeOf<InferInsert<typeof Transformed>['value']>().toEqualTypeOf<string>()

  expectTypeOf<InferUpdate<typeof Transformed>['value']>().toEqualTypeOf<
    string | undefined
  >()

  expectTypeOf<InferSelect<typeof Transformed>['value']>().toEqualTypeOf<number | null>()

  expectTypeOf<
    InferSelectedColumns<typeof Transformed, readonly [typeof Transformed.value]>
  >().toEqualTypeOf<{ value: number | null }>()
})

it('should preserve string input and nullable number output through references', () => {
  const Target = defineTable(
    'nullable_output_reference_targets',
    {
      id: string(),
      value: pipe(
        string(),
        transform((value): number | null => (value === 'null' ? null : Number(value))),
        nullable(number()),
      ),
    },
    { primaryKey: 'id' },
  )

  const Referencing = defineTable(
    'nullable_output_references',
    { id: string(), value: reference(Target, 'value') },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferInsert<typeof Referencing>['value']>().toEqualTypeOf<string>()

  expectTypeOf<InferUpdate<typeof Referencing>['value']>().toEqualTypeOf<
    string | undefined
  >()

  expectTypeOf<InferSelect<typeof Referencing>['value']>().toEqualTypeOf<number | null>()
})

it('should keep nullable transform inputs separate from non-null stored outputs', () => {
  const numberFromNullable = pipe(nullable(string()), toNumber())
  const stringFromNullable = pipe(nullable(string()), toString())
  const Transformed = defineTable(
    'transformed_nullable_views',
    { id: string(), numberFromNullable, stringFromNullable },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferInput<typeof numberFromNullable>>().toEqualTypeOf<string | null>()
  expectTypeOf<InferOutput<typeof numberFromNullable>>().toEqualTypeOf<number>()
  expectTypeOf<InferInput<typeof stringFromNullable>>().toEqualTypeOf<string | null>()
  expectTypeOf<InferOutput<typeof stringFromNullable>>().toEqualTypeOf<string>()

  expectTypeOf<InferSelect<typeof Transformed>>().toEqualTypeOf<{
    id: string
    numberFromNullable: number
    stringFromNullable: string
  }>()

  expectTypeOf<InferInsert<typeof Transformed>['numberFromNullable']>().toEqualTypeOf<
    string | null
  >()

  expectTypeOf<InferInsert<typeof Transformed>['stringFromNullable']>().toEqualTypeOf<
    string | null
  >()
})

it('should infer normalized string and bigint inputs and outputs', () => {
  const lower = pipe(string(), toLowerCase())
  const normalizedBigint = pipe(string(), normalize('NFKC'), toBigint())
  const defaultedNullableBigint = pipe(nullable(string(), '1'), toBigint())
  const nullableBigint = nullable(normalizedBigint)
  const Normalized = defineTable(
    'normalized_nullable_views',
    { id: string(), lower, normalizedBigint, nullableBigint, defaultedNullableBigint },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferInput<typeof lower>>().toEqualTypeOf<string>()
  expectTypeOf<InferOutput<typeof lower>>().toEqualTypeOf<string>()
  expectTypeOf<InferInsert<typeof Normalized>['lower']>().toEqualTypeOf<string>()
  expectTypeOf<InferSelect<typeof Normalized>['lower']>().toEqualTypeOf<string>()

  expectTypeOf<InferInput<typeof normalizedBigint>>().toEqualTypeOf<string>()
  expectTypeOf<InferOutput<typeof normalizedBigint>>().toEqualTypeOf<bigint>()

  expectTypeOf<
    InferInsert<typeof Normalized>['normalizedBigint']
  >().toEqualTypeOf<string>()

  expectTypeOf<InferUpdate<typeof Normalized>['normalizedBigint']>().toEqualTypeOf<
    string | undefined
  >()

  expectTypeOf<
    InferSelect<typeof Normalized>['normalizedBigint']
  >().toEqualTypeOf<bigint>()

  expectTypeOf<InferInsert<typeof Normalized>['nullableBigint']>().toEqualTypeOf<
    string | null
  >()

  expectTypeOf<InferSelect<typeof Normalized>['nullableBigint']>().toEqualTypeOf<
    bigint | null
  >()

  expectTypeOf<InferInsert<typeof Normalized>['defaultedNullableBigint']>().toEqualTypeOf<
    string | null
  >()

  expectTypeOf<
    InferSelect<typeof Normalized>['defaultedNullableBigint']
  >().toEqualTypeOf<bigint>()
})

it('should keep nullish transform inputs and omission separate from stored outputs', () => {
  const numberFromNullish = pipe(
    nullish(string()),
    toNumber(),
    column({ databaseDefault: { kind: 'literal', value: 0 } }),
  )

  const stringFromNullish = pipe(
    nullish(string()),
    toString(),
    column({ databaseDefault: { kind: 'literal', value: 'fallback' } }),
  )

  const Transformed = defineTable(
    'transformed_nullish_views',
    { id: string(), numberFromNullish, stringFromNullish },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferInput<typeof numberFromNullish>>().toEqualTypeOf<
    string | null | undefined
  >()

  expectTypeOf<InferOutput<typeof numberFromNullish>>().toEqualTypeOf<number>()

  expectTypeOf<InferInput<typeof stringFromNullish>>().toEqualTypeOf<
    string | null | undefined
  >()

  expectTypeOf<InferOutput<typeof stringFromNullish>>().toEqualTypeOf<string>()

  expectTypeOf<InferSelect<typeof Transformed>>().toEqualTypeOf<{
    id: string
    numberFromNullish: number
    stringFromNullish: string
  }>()

  expectTypeOf<InferUpdate<typeof Transformed>['numberFromNullish']>().toEqualTypeOf<
    string | null | undefined
  >()

  expectTypeOf<InferInsert<typeof Transformed>['numberFromNullish']>().toEqualTypeOf<
    string | null | undefined
  >()

  expectTypeOf<InferUpdate<typeof Transformed>['stringFromNullish']>().toEqualTypeOf<
    string | null | undefined
  >()
})

it('should preserve SQL nullability for defaulted nullable schemas without a conversion', () => {
  const defaulted = nullable(string(), 'fallback')
  const validated = pipe(defaulted, title('validated'))
  const converted = pipe(defaulted, toString())
  const Defaults = defineTable(
    'nullable_default_views',
    { id: string(), defaulted, validated, converted },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferOutput<typeof defaulted>>().toEqualTypeOf<string>()
  expectTypeOf<InferInput<typeof defaulted>>().toEqualTypeOf<string | null>()

  expectTypeOf<InferSelect<typeof Defaults>['defaulted']>().toEqualTypeOf<string | null>()

  expectTypeOf<InferSelect<typeof Defaults>['validated']>().toEqualTypeOf<string | null>()

  expectTypeOf<InferSelect<typeof Defaults>['converted']>().toEqualTypeOf<string>()

  expectTypeOf<InferInsert<typeof Defaults>['defaulted']>().toEqualTypeOf<string | null>()
})

it('should apply outer nullability wrappers after a converted pipeline', () => {
  const converted = pipe(nullable(string()), toNumber())
  const Wrapped = defineTable(
    'wrapped_transformed_views',
    {
      id: string(),
      nullableOutput: nullable(converted),
      nullishOutput: nullish(converted),
      requiredNullable: nonNullable(nullable(converted)),
      requiredNullish: nonNullish(nullish(converted)),
    },
    { primaryKey: 'id' },
  )

  expectTypeOf<InferSelect<typeof Wrapped>['nullableOutput']>().toEqualTypeOf<
    number | null
  >()

  expectTypeOf<InferSelect<typeof Wrapped>['nullishOutput']>().toEqualTypeOf<
    number | null
  >()

  expectTypeOf<InferSelect<typeof Wrapped>['requiredNullable']>().toEqualTypeOf<number>()

  expectTypeOf<InferSelect<typeof Wrapped>['requiredNullish']>().toEqualTypeOf<number>()

  expectTypeOf<InferInsert<typeof Wrapped>['nullableOutput']>().toEqualTypeOf<
    string | null
  >()
})

describe('InferInsert', () => {
  it('should use schema input for writes and transformed output for reads', () => {
    expectTypeOf<InferInsert<typeof ParsedValue>['value']>().toEqualTypeOf<string>()

    expectTypeOf<InferUpdate<typeof ParsedValue>['value']>().toEqualTypeOf<
      string | undefined
    >()

    expectTypeOf<InferSelect<typeof ParsedValue>['value']>().toEqualTypeOf<number>()
  })

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
  it('should preserve nested wrapper inputs in optional update patches', () => {
    expectTypeOf<InferUpdate<typeof NestedWrappers>>().toEqualTypeOf<{
      id?: string
      optionalNullable?: string | null
      nullableOptional?: string | null
      exactOptional?: string
      undefinedable?: string
      nonOptionalNullableOptional?: string | null
      nonNullableOptionalNullable?: string
      nonNullishNullableOptional?: string
    }>()
  })

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

describe('choice schema views', () => {
  const beyondInt64 = 9223372036854775808n
  const Choices = defineTable(
    'choice_views',
    {
      id: string(),
      status: enumSchema({ ready: 'ready', done: 'done' }),
      count: picklist([1, 2]),
      exact: picklist([0n, beyondInt64]),
      nullableExact: nullable(picklist([1n, 2n])),
    },
    { primaryKey: 'id' },
  )

  it('should preserve choice values and wrappers in select, insert, and update views', () => {
    type Row = InferSelect<typeof Choices>
    type Insert = InferInsert<typeof Choices>
    type Update = InferUpdate<typeof Choices>

    expectTypeOf<Row['status']>().toEqualTypeOf<'ready' | 'done'>()
    expectTypeOf<Row['count']>().toEqualTypeOf<1 | 2>()
    expectTypeOf<Row['exact']>().toEqualTypeOf<0n | 9223372036854775808n>()
    expectTypeOf<Row['nullableExact']>().toEqualTypeOf<1n | 2n | null>()
    expectTypeOf<Insert['count']>().toEqualTypeOf<1 | 2>()
    expectTypeOf<Insert['exact']>().toEqualTypeOf<0n | 9223372036854775808n>()
    expectTypeOf<Update['count']>().toEqualTypeOf<1 | 2 | undefined>()
    expectTypeOf<Update['nullableExact']>().toEqualTypeOf<1n | 2n | null | undefined>()
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
