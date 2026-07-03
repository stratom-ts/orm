import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type { InferRow, InferTable, InferDB } from '@/types/infer'
import {
  boolean,
  nullable,
  nullish,
  number,
  object,
  optional,
  pipe,
  string,
  uuid,
  title,
} from 'valibot'
import { column, references, table } from '@/schemas'
import { describe, it, expectTypeOf } from 'vitest'

const UserSchema = pipe(
  object({
    id: pipe(string(), uuid(), column({ type: 'uuid' })),
    name: pipe(string(), column({ type: 'varchar(255)' })),
    age: nullable(pipe(number(), column({ type: 'integer' }))),
    email: optional(pipe(string(), column({ type: 'text' }))),
    bio: nullish(pipe(string(), column({ type: 'text' }))),
    active: pipe(boolean(), column({ type: 'boolean', default: true })),
  }),
  title('users'),
  table({ name: 'users', primaryKey: 'id' }),
)

const PostSchema = pipe(
  object({
    id: pipe(string(), uuid(), column({ type: 'uuid' })),
    title: pipe(string(), column({ type: 'text' })),
    userId: references(UserSchema, 'id'),
  }),
  title('posts'),
  table({ name: 'posts', primaryKey: 'id' }),
)

describe('InferRow', () => {
  it('infers required columns as required non-nullable properties', () => {
    type Row = InferRow<typeof UserSchema>
    expectTypeOf<Row>().toExtend<{
      id: string
      name: string
      age: number | null
      email: string
      bio: string | null
      active: boolean
    }>()
  })

  it('preserves null for nullable columns', () => {
    type Row = InferRow<typeof UserSchema>
    expectTypeOf<Row['age']>().toEqualTypeOf<number | null>()
  })

  it('strips undefined for optional columns', () => {
    type Row = InferRow<typeof UserSchema>
    expectTypeOf<Row['email']>().toEqualTypeOf<string>()
  })

  it('strips undefined but keeps null for nullish columns', () => {
    type Row = InferRow<typeof UserSchema>
    expectTypeOf<Row['bio']>().toEqualTypeOf<string | null>()
  })

  it('all columns are required (no optional properties)', () => {
    type Row = InferRow<typeof UserSchema>
    expectTypeOf<Row>().toHaveProperty('id')
    expectTypeOf<Row>().toHaveProperty('name')
    expectTypeOf<Row>().toHaveProperty('age')
    expectTypeOf<Row>().toHaveProperty('email')
    expectTypeOf<Row>().toHaveProperty('bio')
    expectTypeOf<Row>().toHaveProperty('active')
  })
})

describe('InferDB', () => {
  it('infers a Kysely-compatible Database type from a record of schemas', () => {
    type DB = InferDB<{ users: typeof UserSchema; posts: typeof PostSchema }>
    expectTypeOf<DB['users']>().toExtend<{
      id: string
      name: string
      age: number | null
      email: string
      bio: string | null
      active: boolean
    }>()
    expectTypeOf<DB['posts']>().toExtend<{
      id: string
      title: string
      userId: string
    }>()
  })

  it('reference columns inherit the referenced column type', () => {
    type DB = InferDB<{ users: typeof UserSchema; posts: typeof PostSchema }>
    expectTypeOf<DB['posts']['userId']>().toEqualTypeOf<
      DB['users']['id']
    >()
  })

  it('handles single-table DB type', () => {
    type DB = InferDB<{ users: typeof UserSchema }>
    expectTypeOf<DB['users']['id']>().toEqualTypeOf<string>()
    expectTypeOf<DB['users']['age']>().toEqualTypeOf<number | null>()
  })
})

const JsonSchema = pipe(
  object({
    id: pipe(string(), uuid(), column({ type: 'uuid' })),
    metadata: pipe(
      object({ key: string(), value: number() }),
      column({ type: 'jsonb' }),
    ),
    nullableMetadata: nullable(pipe(
      object({ key: string(), value: number() }),
      column({ type: 'jsonb' }),
    )),
    configOverride: pipe(
      object({ key: string(), value: number() }),
      column({ type: 'jsonb' }),
    ),
  }),
  title('json_test'),
  table({ name: 'json_test', primaryKey: 'id' }),
)

const JsonRefSchema = pipe(
  object({
    id: pipe(string(), uuid(), column({ type: 'uuid' })),
    refToMetadata: references(JsonSchema, 'metadata'),
  }),
  title('json_ref_test'),
  table({ name: 'json_ref_test', primaryKey: 'id' }),
)

describe('InferTable', () => {
  it('without config defaults to same as InferRow', () => {
    type Table = InferTable<typeof UserSchema>
    type Row = InferRow<typeof UserSchema>
    expectTypeOf<Table>().toEqualTypeOf<Row>()
  })

  it('wraps with Generated<T> when generated: true', () => {
    type Table = InferTable<typeof UserSchema, { id: { generated: true } }>
    expectTypeOf<Table['id']>().toEqualTypeOf<Generated<string>>()
    expectTypeOf<Table['name']>().toEqualTypeOf<string>()
  })

  it('wraps with ColumnType<T, T, never> when readonly: true', () => {
    type Table = InferTable<typeof UserSchema, { id: { readonly: true } }>
    expectTypeOf<Table['id']>().toEqualTypeOf<ColumnType<string, string, never>>()
  })

  it('wraps with JSONColumnType<T> when json: true', () => {
    type Table = InferTable<typeof JsonSchema, { metadata: { json: true } }>
    expectTypeOf<Table['metadata']>().toEqualTypeOf<
      JSONColumnType<{ key: string; value: number }>
    >()
  })

  it('auto-detects JSONColumnType for object schemas without explicit config', () => {
    type Table = InferTable<typeof JsonSchema>
    expectTypeOf<Table['metadata']>().toEqualTypeOf<
      JSONColumnType<{ key: string; value: number }>
    >()
  })

  it('auto-detects JSONColumnType for nullable object schemas', () => {
    type Table = InferTable<typeof JsonSchema>
    expectTypeOf<Table['nullableMetadata']>().toExtend<
      JSONColumnType<{ key: string; value: number } | null>
    >()
  })

  it('does not auto-detect JSON for object columns with explicit non-json config', () => {
    type Table = InferTable<
      typeof JsonSchema,
      { configOverride: { json: false } }
    >
    expectTypeOf<Table['configOverride']>().toEqualTypeOf<
      { key: string; value: number }
    >()
  })

  it('does not auto-detect JSON for object columns with unrelated explicit config', () => {
    type Table = InferTable<
      typeof JsonSchema,
      { configOverride: { readonly: true } }
    >
    expectTypeOf<Table['configOverride']>().toEqualTypeOf<
      ColumnType<{ key: string; value: number }, { key: string; value: number }, never>
    >()
  })

  it('does not auto-detect JSON for reference columns', () => {
    type Table = InferTable<typeof JsonRefSchema>
    expectTypeOf<Table['refToMetadata']>().not.toEqualTypeOf<
      JSONColumnType<{ key: string; value: number }>
    >()
  })
})

describe('InferDB with configs', () => {
  it('applies per-table KyselyColumnConfigs', () => {
    type DB = InferDB<
      { users: typeof UserSchema },
      { users: { id: { generated: true }; active: { readonly: true } } }
    >
    expectTypeOf<DB['users']['id']>().toEqualTypeOf<Generated<string>>()
    expectTypeOf<DB['users']['active']>().toEqualTypeOf<
      ColumnType<boolean, boolean, never>
    >()
    expectTypeOf<DB['users']['name']>().toEqualTypeOf<string>()
  })

  it('without configs is backward compatible', () => {
    type DB = InferDB<{ users: typeof UserSchema; posts: typeof PostSchema }>
    expectTypeOf<DB['users']['id']>().toEqualTypeOf<string>()
    expectTypeOf<DB['posts']['userId']>().toEqualTypeOf<string>()
  })
})

describe('compile-time type assertions', () => {
  it('InferRow produces correct shape for simple schemas', () => {
    const SimpleSchema = pipe(
      object({
        id: pipe(string(), uuid(), column({ type: 'uuid' })),
        label: pipe(string(), column({ type: 'text' })),
      }),
      title('items'),
      table({ name: 'items', primaryKey: 'id' }),
    )
    type Row = InferRow<typeof SimpleSchema>
    expectTypeOf<Row>().toExtend<{ id: string; label: string }>()
  })
})
