import {
  boolean,
  nullable,
  number,
  object,
  optional,
  parse,
  pipe,
  string,
  title,
} from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ColumnRef, InferSelect, TableHandle } from '@/index'
import {
  SchemaError,
  column,
  defineTable,
  getReferenceMetadata,
  isTableHandle,
  reference,
  table,
} from '@/index'
import { validateInsertRow } from '@/query'

const userColumns = {
  id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
  email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
  fullName: pipe(string(), column({ type: 'text' })),
  age: nullable(pipe(number(), column({ type: 'integer' }))),
  bio: optional(pipe(string(), column({ type: 'text', default: '' }))),
  active: pipe(boolean(), column({ type: 'boolean', default: true })),
}

const User = defineTable('users', userColumns, {
  schema: 'public',
  primaryKey: 'id',
  indexes: [
    { columns: ['email'], unique: true },
    { name: 'users_full_name_idx', columns: ['fullName'] },
  ],
})

// Raw-schema form (built from the primitives) still works for reference()
// targets and Infer* helpers that accept a schema rather than a handle.
const UserSchema = pipe(
  object(userColumns),
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
  it('should return a table handle with getSchema and getTableMetadata', () => {
    expect(isTableHandle(User)).toBe(true)

    expect(User.getTableMetadata()).toMatchObject({
      kind: 'table',
      name: 'users',
      schema: 'public',
      primaryKey: 'id',
    })

    expect(User.getSchema().entries.email).toBeDefined()
  })

  it('should expose column refs on the handle', () => {
    expect(User.email).toMatchObject({
      table: 'users',
      column: 'email',
      schema: 'public',
    })

    expect(User.id.column).toBe('id')
  })

  it('should support composite primary keys and index configs', () => {
    const Membership = defineTable(
      'memberships',
      {
        orgId: pipe(string(), column({ type: 'uuid' })),
        userId: pipe(string(), column({ type: 'uuid' })),
        role: pipe(string(), column({ type: 'text' })),
      },
      {
        primaryKey: ['orgId', 'userId'],
        indexes: [
          { name: 'memberships_role_idx', columns: ['role'] },
          { columns: ['orgId', 'role'], unique: true },
        ],
      },
    )
    expect(Membership.getTableMetadata().primaryKey).toEqual(['orgId', 'userId'])
    expect(Membership.getTableMetadata().indexes).toEqual([
      { name: 'memberships_role_idx', columns: ['role'] },
      { columns: ['orgId', 'role'], unique: true },
    ])
  })

  it('should accept string indexes for backward compatibility', () => {
    const Tag = defineTable(
      'tags',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        label: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', indexes: ['label'] },
    )
    expect(Tag.getTableMetadata().indexes).toEqual(['label'])
  })

  it('should throw SchemaError when primaryKey column is missing', () => {
    expect(() =>
      defineTable(
        'bad',
        { id: pipe(string(), column({ type: 'uuid' })) },
        // @ts-expect-error - 'missing' is not a declared column
        { primaryKey: 'missing' },
      ),
    ).toThrow(SchemaError)

    expect(() =>
      defineTable(
        'bad',
        { id: pipe(string(), column({ type: 'uuid' })) },
        // @ts-expect-error - 'missing' is not a declared column
        { primaryKey: 'missing' },
      ),
    ).toThrow(/primaryKey column "missing"/)
  })

  it('should throw SchemaError when index column is missing', () => {
    expect(() =>
      defineTable(
        'bad',
        { id: pipe(string(), column({ type: 'uuid' })) },
        // @ts-expect-error - 'nope' is not a declared column
        { primaryKey: 'id', indexes: [{ columns: ['nope'] }] },
      ),
    ).toThrow(/index column "nope"/)
  })

  it('should throw SchemaError for empty composite primary key', () => {
    expect(() =>
      defineTable(
        'bad',
        { id: pipe(string(), column({ type: 'uuid' })) },
        { primaryKey: [] },
      ),
    ).toThrow(SchemaError)
  })

  it('should throw SchemaError when a column name collides with a reserved handle method', () => {
    expect(() =>
      defineTable(
        'bad',
        {
          id: pipe(string(), column({ type: 'uuid' })),
          getSchema: pipe(string(), column({ type: 'text' })),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(SchemaError)

    expect(() =>
      defineTable(
        'bad',
        {
          id: pipe(string(), column({ type: 'uuid' })),
          getTableMetadata: pipe(string(), column({ type: 'text' })),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/reserved/)
  })

  it('should defer physical identity compatibility to the selected adapter', () => {
    expect(() =>
      defineTable(
        'bad',
        {
          id: pipe(string(), column({ type: 'uuid', generated: 'byDefault' })),
        },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()
    expect(() =>
      defineTable(
        'bad',
        {
          id: pipe(string(), column({ type: 'uuid', generated: 'byDefault' })),
        },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()
  })

  it('should require a value source for optional NOT NULL columns', () => {
    expect(() =>
      defineTable(
        'invalid_optional',
        { id: optional(pipe(string(), column({ type: 'text' }))) },
        { primaryKey: 'id' },
      ),
    ).toThrow(/requires a default or generated value/)

    expect(() =>
      defineTable(
        'null_default',
        { id: optional(pipe(string(), column({ type: 'text', default: null }))) },
        { primaryKey: 'id' },
      ),
    ).toThrow(/cannot default to null/)
  })

  it('should accept database and Valibot defaults for optional columns', () => {
    expect(() =>
      defineTable(
        'database_default',
        { id: optional(pipe(string(), column({ type: 'text', default: 'new' }))) },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()

    const SchemaDefault = defineTable(
      'schema_default',
      { id: optional(string(), 'new') },
      { primaryKey: 'id' },
    )
    expect(parse(SchemaDefault.getSchema(), {})).toEqual({ id: 'new' })
    expect(validateInsertRow(SchemaDefault, {})).toEqual({ id: 'new' })
  })

  it('should accept generated and autoIncrement value sources for optional columns', () => {
    expect(() =>
      defineTable(
        'optional_generated',
        {
          id: optional(
            pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
          ),
        },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()

    expect(() =>
      defineTable(
        'optional_auto_increment',
        {
          id: optional(pipe(number(), column({ type: 'integer', autoIncrement: true }))),
        },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()
  })

  it('should retain adapter-owned column metadata during construction', () => {
    expect(() =>
      defineTable(
        'commented',
        { id: pipe(string(), column({ type: 'text', comment: 'unsupported' })) },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()

    expect(() =>
      defineTable(
        'updated',
        { id: pipe(string(), column({ type: 'text', onUpdate: 'now()' })) },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()
  })

  it('should reject defaults combined with identity generation', () => {
    expect(() =>
      defineTable(
        'bad_identity',
        {
          id: pipe(
            number(),
            column({ type: 'integer', generated: 'byDefault', default: 1 }),
          ),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/cannot combine a default with identity/)
    expect(() =>
      defineTable(
        'bad_tagged_identity',
        {
          id: pipe(
            number(),
            column({
              type: 'integer',
              databaseDefault: { kind: 'literal', value: 1 },
              generation: { kind: 'identity', mode: 'byDefault' },
            }),
          ),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/cannot combine a default with identity/)
  })

  it('should reject duplicate index definitions', () => {
    expect(() =>
      defineTable(
        'indexed',
        {
          id: pipe(string(), column({ type: 'text' })),
          email: pipe(string(), column({ type: 'text' })),
        },
        { primaryKey: 'id', indexes: ['email', { columns: ['email'] }] },
      ),
    ).toThrow(/duplicate index definition/)
  })

  it('should reject duplicate and nullable structural key members', () => {
    expect(() =>
      defineTable(
        'duplicate_pk',
        { id: pipe(string(), column({ type: 'text' })) },
        { primaryKey: ['id', 'id'] },
      ),
    ).toThrow(/duplicate columns/i)
    expect(() =>
      defineTable(
        'nullable_pk',
        { id: nullable(pipe(string(), column({ type: 'text' }))) },
        { primaryKey: 'id' },
      ),
    ).toThrow(/cannot be nullable/i)
    expect(() =>
      defineTable(
        'duplicate_index',
        {
          id: pipe(string(), column({ type: 'text' })),
          value: pipe(string(), column({ type: 'text' })),
        },
        { primaryKey: 'id', indexes: [{ columns: ['value', 'value'] }] },
      ),
    ).toThrow(/index.*duplicate columns/i)
  })

  it('should reject null database defaults and incoherent FK actions structurally', () => {
    expect(() =>
      defineTable(
        'null_default',
        {
          id: pipe(
            string(),
            column({
              databaseDefault: { kind: 'literal', value: null },
            }),
          ),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/NOT NULL.*null database default/i)

    expect(() =>
      defineTable(
        'bad_set_null',
        {
          id: pipe(string(), column({ type: 'uuid' })),
          userId: reference(User, 'id', { onDelete: 'set null' }),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/SET NULL.*NOT NULL/i)

    expect(() =>
      defineTable(
        'bad_set_default',
        {
          id: pipe(string(), column({ type: 'uuid' })),
          userId: reference(User, 'id', { onDelete: 'set default' }),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/SET DEFAULT.*without a database default/i)

    expect(() =>
      defineTable(
        'valid_set_default',
        {
          id: pipe(string(), column({ type: 'uuid' })),
          userId: pipe(
            reference(User, 'id', { onDelete: 'set default' }),
            column({
              databaseDefault: {
                kind: 'literal',
                value: '00000000-0000-0000-0000-000000000000',
              },
            }),
          ),
        },
        { primaryKey: 'id' },
      ),
    ).not.toThrow()
  })

  it('should reject conflicting legacy and tagged physical intent', () => {
    expect(() =>
      defineTable(
        'conflicting_type',
        {
          id: pipe(
            string(),
            column({ type: 'uuid', physicalType: { postgresql: 'uuid' } }),
          ),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/legacy and dialect-keyed physical types/i)
    expect(() =>
      defineTable(
        'conflicting_generation',
        {
          id: pipe(
            number(),
            column({
              type: 'integer',
              generated: 'always',
              generation: { kind: 'identity', mode: 'always' },
            }),
          ),
        },
        { primaryKey: 'id' },
      ),
    ).toThrow(/legacy and tagged generation/i)
  })
})

describe('reference with FK actions', () => {
  it('should store onDelete and onUpdate on reference metadata', () => {
    const Post = defineTable(
      'posts',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        authorId: reference(UserSchema, 'id', {
          onDelete: 'cascade',
          onUpdate: 'restrict',
        }),
      },
      { primaryKey: 'id' },
    )

    const meta = getReferenceMetadata(Post.getSchema().entries.authorId)
    expect(meta).toMatchObject({
      kind: 'reference',
      schema: 'public',
      table: 'users',
      key: 'id',
      onDelete: 'cascade',
      onUpdate: 'restrict',
    })
  })

  it('should accept a table handle as reference target', () => {
    const Post = defineTable(
      'posts',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        authorId: nullable(reference(User, 'id', { onDelete: 'set null' })),
      },
      { primaryKey: 'id' },
    )

    const meta = getReferenceMetadata(Post.getSchema().entries.authorId)
    expect(meta?.table).toBe('users')
    expect(meta?.onDelete).toBe('set null')
  })
})

describe('table handle typing', () => {
  it('should match the raw schema and handle with InferSelect', () => {
    type FromSchema = InferSelect<typeof UserSchema>
    type FromHandle = InferSelect<typeof User>
    expectTypeOf<FromSchema['id']>().toEqualTypeOf<FromHandle['id']>()
    expectTypeOf<FromSchema['email']>().toEqualTypeOf<FromHandle['email']>()
  })

  it('should type column refs on the handle', () => {
    type EmailRef = (typeof User)['email']
    expectTypeOf<EmailRef['table']>().toEqualTypeOf<'users'>()
    expectTypeOf<EmailRef['column']>().toEqualTypeOf<'email'>()
    expectTypeOf<EmailRef>().toExtend<ColumnRef>()
    expectTypeOf<typeof User>().toExtend<TableHandle>()
  })
})
