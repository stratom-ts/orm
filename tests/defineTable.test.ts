import {
  boolean,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  title,
} from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineTable, isTableHandle } from '@/defineTable'
import type { ColumnRef, TableHandle } from '@/defineTable'
import { column, getReferenceMetadata, references, table } from '@/schemas'
import type { InferInsert, InferSelect, InferUpdate } from '@/types/views'
import { SchemaError } from '@/utils/error'

const UserSchema = pipe(
  object({
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
    fullName: pipe(string(), column({ type: 'text' })),
    age: nullable(pipe(number(), column({ type: 'integer' }))),
    bio: optional(pipe(string(), column({ type: 'text' }))),
    active: pipe(boolean(), column({ type: 'boolean', default: true })),
  }),
  title('users'),
  table({
    name: 'users',
    schema: 'public',
    primaryKey: 'id',
    indexes: [
      { columns: ['email'], unique: true },
      { name: 'users_full_name_idx', columns: ['fullName'] },
    ],
  }),
)

describe('defineTable', () => {
  it('returns a table handle with name, schema, and metadata', () => {
    const User = defineTable(UserSchema)
    expect(isTableHandle(User)).toBe(true)
    expect(User.name).toBe('users')
    expect(User.schema).toBe('public')
    expect(User.metadata).toMatchObject({
      kind: 'table',
      name: 'users',
      schema: 'public',
      primaryKey: 'id',
    })
    expect(User.definition).toBe(UserSchema)
  })

  it('exposes column refs on the handle and under .columns', () => {
    const User = defineTable(UserSchema)
    expect(User.email).toEqual({
      table: 'users',
      column: 'email',
      schema: 'public',
      __type: undefined,
    })
    expect(User.columns.email).toEqual(User.email)
    expect(User.id.column).toBe('id')
  })

  it('supports composite primary keys and index configs', () => {
    const MembershipSchema = pipe(
      object({
        orgId: pipe(string(), column({ type: 'uuid' })),
        userId: pipe(string(), column({ type: 'uuid' })),
        role: pipe(string(), column({ type: 'text' })),
      }),
      title('memberships'),
      table({
        name: 'memberships',
        primaryKey: ['orgId', 'userId'],
        indexes: [
          { name: 'memberships_role_idx', columns: ['role'] },
          { columns: ['orgId', 'role'], unique: true },
        ],
      }),
    )
    const Membership = defineTable(MembershipSchema)
    expect(Membership.metadata.primaryKey).toEqual(['orgId', 'userId'])
    expect(Membership.metadata.indexes).toEqual([
      { name: 'memberships_role_idx', columns: ['role'] },
      { columns: ['orgId', 'role'], unique: true },
    ])
  })

  it('accepts string indexes for backward compatibility', () => {
    const TagSchema = pipe(
      object({
        id: pipe(string(), column({ type: 'uuid' })),
        label: pipe(string(), column({ type: 'text' })),
      }),
      title('tags'),
      table({ name: 'tags', primaryKey: 'id', indexes: ['label'] }),
    )
    const Tag = defineTable(TagSchema)
    expect(Tag.metadata.indexes).toEqual(['label'])
  })

  it('throws SchemaError when table metadata is missing', () => {
    const Bad = pipe(object({ id: string() }), title('bad'))
    expect(() => defineTable(Bad as never)).toThrow(SchemaError)
    try {
      defineTable(Bad as never)
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError)
      expect((e as SchemaError)._tag).toBe('SchemaError')
    }
  })

  it('throws SchemaError when primaryKey column is missing', () => {
    const Bad = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
      title('bad'),
      table({ name: 'bad', primaryKey: 'missing' }),
    )
    expect(() => defineTable(Bad)).toThrow(SchemaError)
    expect(() => defineTable(Bad)).toThrow(/primaryKey column "missing"/)
  })

  it('throws SchemaError when index column is missing', () => {
    const Bad = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
      title('bad'),
      table({
        name: 'bad',
        primaryKey: 'id',
        indexes: [{ columns: ['nope'] }],
      }),
    )
    expect(() => defineTable(Bad)).toThrow(/index column "nope"/)
  })

  it('throws SchemaError for empty composite primary key', () => {
    const Bad = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
      title('bad'),
      table({ name: 'bad', primaryKey: [] }),
    )
    expect(() => defineTable(Bad)).toThrow(SchemaError)
  })

  it('throws SchemaError when a column name collides with a reserved handle field', () => {
    const Bad = pipe(
      object({
        id: pipe(string(), column({ type: 'uuid' })),
        name: pipe(string(), column({ type: 'text' })),
      }),
      title('bad'),
      table({ name: 'bad', primaryKey: 'id' }),
    )
    expect(() => defineTable(Bad)).toThrow(SchemaError)
    expect(() => defineTable(Bad)).toThrow(/reserved/)
  })

  it('throws SchemaError when identity is used on a non-integer type', () => {
    const Bad = pipe(
      object({
        id: pipe(string(), column({ type: 'uuid', generated: 'byDefault' })),
      }),
      title('bad'),
      table({ name: 'bad', primaryKey: 'id' }),
    )
    expect(() => defineTable(Bad)).toThrow(SchemaError)
    expect(() => defineTable(Bad)).toThrow(/identity/)
  })
})

describe('references with FK actions', () => {
  it('stores onDelete and onUpdate on reference metadata', () => {
    const User = defineTable(UserSchema)
    const PostSchema = pipe(
      object({
        id: pipe(string(), column({ type: 'uuid' })),
        authorId: references(UserSchema, 'id', {
          onDelete: 'cascade',
          onUpdate: 'restrict',
        }),
      }),
      title('posts'),
      table({ name: 'posts', primaryKey: 'id' }),
    )
    const Post = defineTable(PostSchema)
    const meta = getReferenceMetadata(Post.definition.entries.authorId)
    expect(meta).toMatchObject({
      kind: 'reference',
      schema: 'public',
      table: 'users',
      key: 'id',
      onDelete: 'cascade',
      onUpdate: 'restrict',
    })
    expect(User).toBeDefined()
  })

  it('accepts a table handle as reference target', () => {
    const User = defineTable(UserSchema)
    const PostSchema = pipe(
      object({
        id: pipe(string(), column({ type: 'uuid' })),
        authorId: references(User, 'id', { onDelete: 'set null' }),
      }),
      title('posts'),
      table({ name: 'posts', primaryKey: 'id' }),
    )
    const Post = defineTable(PostSchema)
    const meta = getReferenceMetadata(Post.definition.entries.authorId)
    expect(meta?.table).toBe('users')
    expect(meta?.onDelete).toBe('set null')
  })
})

describe('InferSelect / InferInsert / InferUpdate', () => {
  const User = defineTable(UserSchema)

  it('InferSelect is a full row type', () => {
    type Row = InferSelect<typeof User>
    expectTypeOf<Row['id']>().toEqualTypeOf<number>()
    expectTypeOf<Row['email']>().toEqualTypeOf<string>()
    expectTypeOf<Row['fullName']>().toEqualTypeOf<string>()
    expectTypeOf<Row['age']>().toEqualTypeOf<number | null>()
    // optional() is omit-on-insert only; SQL is NOT NULL → select is non-null string
    expectTypeOf<Row['bio']>().toEqualTypeOf<string>()
    expectTypeOf<Row['active']>().toEqualTypeOf<boolean>()
  })

  it('InferInsert omits always-generated and makes defaults optional', () => {
    const AlwaysSchema = pipe(
      object({
        id: pipe(number(), column({ type: 'integer', generated: 'always' })),
        email: pipe(string(), column({ type: 'text' })),
        active: pipe(boolean(), column({ type: 'boolean', default: true })),
        note: optional(pipe(string(), column({ type: 'text' }))),
      }),
      title('t'),
      table({ name: 't', primaryKey: 'id' }),
    )
    const T = defineTable(AlwaysSchema)
    type Insert = InferInsert<typeof T>
    expectTypeOf<Insert['email']>().toEqualTypeOf<string>()
    expectTypeOf<Insert['active']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<Insert['note']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Insert>().not.toHaveProperty('id')

    type InsertUser = InferInsert<typeof User>
    expectTypeOf<InsertUser['email']>().toEqualTypeOf<string>()
    expectTypeOf<InsertUser['fullName']>().toEqualTypeOf<string>()
    expectTypeOf<InsertUser['age']>().toEqualTypeOf<number | null>()
    expectTypeOf<InsertUser['id']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<InsertUser['bio']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<InsertUser['active']>().toEqualTypeOf<boolean | undefined>()
  })

  it('InferUpdate is a partial patch without readonly / always-generated', () => {
    const ReadonlySchema = pipe(
      object({
        id: pipe(number(), column({ type: 'integer', generated: 'always' })),
        createdAt: pipe(string(), column({ type: 'text', readonly: true })),
        label: pipe(string(), column({ type: 'text' })),
      }),
      title('r'),
      table({ name: 'r', primaryKey: 'id' }),
    )
    const R = defineTable(ReadonlySchema)
    type Update = InferUpdate<typeof R>
    expectTypeOf<Update['label']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Update>().not.toHaveProperty('id')
    expectTypeOf<Update>().not.toHaveProperty('createdAt')
  })

  it('nested object columns without references stay JSON-shaped objects', () => {
    const JsonSchema = pipe(
      object({
        id: pipe(string(), column({ type: 'uuid' })),
        payload: pipe(
          object({ key: string(), value: number() }),
          column({ type: 'jsonb' }),
        ),
      }),
      title('j'),
      table({ name: 'j', primaryKey: 'id' }),
    )
    const J = defineTable(JsonSchema)
    type Select = InferSelect<typeof J>
    type Insert = InferInsert<typeof J>
    expectTypeOf<Select['payload']>().toEqualTypeOf<{
      key: string
      value: number
    }>()
    expectTypeOf<Insert['payload']>().toEqualTypeOf<{
      key: string
      value: number
    }>()
  })

  it('works from the raw schema as well as the handle', () => {
    type FromSchema = InferSelect<typeof UserSchema>
    type FromHandle = InferSelect<typeof User>
    expectTypeOf<FromSchema['id']>().toEqualTypeOf<FromHandle['id']>()
    expectTypeOf<FromSchema['email']>().toEqualTypeOf<FromHandle['email']>()
  })

  it('types column refs', () => {
    type EmailRef = (typeof User)['email']
    expectTypeOf<EmailRef['table']>().toEqualTypeOf<'users'>()
    expectTypeOf<EmailRef['column']>().toEqualTypeOf<'email'>()
    expectTypeOf<EmailRef>().toExtend<ColumnRef>()
    expectTypeOf<typeof User>().toExtend<TableHandle>()
  })
})
