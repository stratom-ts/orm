import type { InferRow, InferDB } from '@/types/infer'
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
