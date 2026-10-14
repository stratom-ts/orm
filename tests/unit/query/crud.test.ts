import {
  boolean,
  exactOptional,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  number,
  optional,
  pipe,
  string,
  undefinedable,
} from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Db } from '@/index'
import {
  DriverError,
  QueryError,
  ValidationError,
  column,
  createDatabase,
  defineTable,
} from '@/index'

import {
  createMockPostgresConnector as createMockConnector,
  createMockStatement,
} from '../helpers/nativePostgresClient'

/** Checks public query context while retaining the unchanged native diagnostic. */
function expectWriteFailure(
  failure: unknown,
  operation: string,
  secret: string,
  cause: Error,
): void {
  expect(failure).toBeInstanceOf(DriverError)
  expect((failure as DriverError).message).toContain(operation)
  expect((failure as DriverError).message).toContain('users')
  expect((failure as DriverError).message).not.toContain(secret)
  expect((failure as DriverError).cause).toBe(cause)
  expect(JSON.stringify(failure)).toContain(`native failure: ${secret}`)
}

/** Runs one public write and returns its rejected value for context assertions. */
async function captureWriteFailure(operation: () => Promise<unknown>): Promise<unknown> {
  return operation().catch((cause: unknown) => cause)
}

/** Creates a connector that rejects executed insert/update statements. */
function createFailingWriteConnector(cause: Error) {
  return createMockConnector({
    onPrepare(sql) {
      const statement = createMockStatement()

      if (/^\s*(insert|update)/i.test(sql)) {
        statement.all = async () => {
          throw cause
        }

        statement.run = async () => {
          throw cause
        }
      }

      return statement
    },
  })
}

const Users = defineTable(
  'users',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    displayName: optional(
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
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

const AlwaysId = defineTable(
  'always_id',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'always' },
      }),
    ),
    label: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
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
  },
  { primaryKey: 'id' },
)

const WrapperBehavior = defineTable(
  'wrapper_behavior',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    exact: exactOptional(
      pipe(
        string(),
        column({
          physicalType: { postgresql: 'varchar(20)' },
          databaseDefault: { kind: 'literal', value: 'default' },
        }),
      ),
    ),
    undefinedValue: undefinedable(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    nullableValue: nullable(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    nullishValue: nullish(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    nonOptionalValue: nonOptional(
      optional(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
    nonNullableValue: nonNullable(
      optional(
        nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
      ),
    ),
    nonNullishValue: nonNullish(
      nullish(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
  },
  { primaryKey: 'id' },
)

describe('CRUD compile', () => {
  it('applies wrapper omission and nullability semantics during insert validation', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [WrapperBehavior] })

    const complete = {
      id: '1',
      undefinedValue: 'u',
      nullableValue: null,
      nullishValue: 'z',
      nonOptionalValue: 'o',
      nonNullableValue: 'n',
      nonNullishValue: 'q',
    }

    assertRequiredInsertValues(complete, db)

    const { nullishValue: _nullishValue, ...exactAndNullishRow } = complete
    void _nullishValue

    const exactAndNullish = db
      .insert(WrapperBehavior)
      .values(exactAndNullishRow as never)
      .compile()

    expect(exactAndNullish.sql.toLowerCase()).not.toContain('"exact"')
    expect(exactAndNullish.sql.toLowerCase()).not.toContain('"nullishvalue"')

    const explicitNull = db
      .insert(WrapperBehavior)
      .values({ ...complete, nullishValue: null } as never)
      .compile()

    expect(explicitNull.params).toContain(null)

    expect(() =>
      db
        .insert(WrapperBehavior)
        .values({ id: '1', undefinedValue: undefined } as never)
        .compile(),
    ).toThrow(/cannot be undefined/)

    await db.close()
  })
})

describe('CRUD compile: should compile insert with parameterized values and schema-qualified table', () => {
  it('should compile insert with parameterized values and schema-qualified table', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .insert(Users)
      .values({ email: 'a@b.com', displayName: 'Ada' })
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('insert into')
    expect(compiled.sql).toContain('"public"')
    expect(compiled.sql).toContain('"users"')
    expect(compiled.sql).toMatch(/\$1/)
    expect(compiled.params).toEqual(expect.arrayContaining(['a@b.com', 'Ada']))
    expect(compiled.sql.toLowerCase()).not.toContain('a@b.com')

    await db.close()
  })

  it('should compile bulk insert', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .insert(Users)
      .values([{ email: 'a@b.com' }, { email: 'b@c.com', displayName: 'Bob' }])
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('values')
    expect(compiled.sql.toLowerCase()).toMatch(/default/)

    expect(compiled.params.filter((p) => typeof p === 'string')).toEqual(
      expect.arrayContaining(['a@b.com', 'b@c.com', 'Bob']),
    )

    await db.close()
  })
})

describe('CRUD compile: should compile insert with parameterized values and schema-qualified table: should compile update with where and default returning *', () => {
  it('should compile update with where and default returning *', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .update(Users)
      .set({ displayName: 'X' })
      .where(Users.email, 'eq', 'a@b.com')
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('update')
    expect(compiled.sql.toLowerCase()).toContain('set')
    expect(compiled.sql.toLowerCase()).toContain('where')
    expect(compiled.sql.toLowerCase()).toContain('returning *')
    expect(compiled.params).toEqual(['X', 'a@b.com'])

    await db.close()
  })
})

describe('CRUD compile: should compile delete with object where and column returning', () => {
  it('should compile delete with object where and column returning', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .delete(Users)
      .where({ email: 'a@b.com' })
      .returning([Users.id])
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('delete from')
    expect(compiled.sql).toContain('"id"')
    expect(compiled.params).toEqual(['a@b.com'])

    await db.close()
  })
})

describe('CRUD input validation', () => {
  it('should reject empty returning projections', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.insert(Users).values({ email: 'a@b.com' }).returning([])).toThrow(
      /requires at least one column/,
    )

    expect(() => db.update(Users).set({ active: false }).all().returning([])).toThrow(
      /requires at least one column/,
    )

    expect(() => db.delete(Users).all().returning([])).toThrow(
      /requires at least one column/,
    )

    await db.close()
  })

  it('should reject empty insert rows synchronously at the public boundary before database work', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.insert(Users).values([] as never)).toThrow(
      /requires at least one row/,
    )

    expect(connector.prepared).toEqual([])
    await db.close()
  })

  it('should reject empty update patches synchronously at the public boundary before database work', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.update(Users).set({} as never)).toThrow(
      /patch must include at least one column/,
    )

    expect(connector.prepared).toEqual([])
    await db.close()
  })
})

describe('CRUD input validation: should reject empty where inputs synchronously at the public boundary before database work', () => {
  it('should reject empty where inputs synchronously at the public boundary before database work', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() =>
      db
        .update(Users)
        .set({ active: false })
        .where({} as never),
    ).toThrow(/requires at least one key/)

    expect(connector.prepared).toEqual([])
    await db.close()
  })

  it('should reject update where(...).all() before connector preparation', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.update(Users).set({ active: false }).where(Users.id, 'eq', 1).all()

    await expect(query.execute()).rejects.toMatchObject({
      _tag: 'QueryError',
      message: expect.stringContaining('cannot combine where(...) and .all()') as unknown,
    })

    expect(connector.prepared).toEqual([])

    await db.close()
  })
})

describe('CRUD input validation: should reject update all().where(...) before connector preparation', () => {
  it('should reject update all().where(...) before connector preparation', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.update(Users).set({ active: false }).all().where(Users.id, 'eq', 1)

    await expect(query.execute()).rejects.toMatchObject({
      _tag: 'QueryError',
      message: expect.stringContaining('cannot combine where(...) and .all()') as unknown,
    })

    expect(connector.prepared).toEqual([])

    await db.close()
  })
})

describe('CRUD input validation: should reject an empty delete predicate with a tagged error before connector preparation', () => {
  it('should reject an empty delete predicate with a tagged error before connector preparation', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.delete(Users).where({} as never)).toThrow(
      expect.objectContaining({
        _tag: 'QueryError',
        message: expect.stringMatching(/requires at least one key/i) as unknown,
      }),
    )

    expect(connector.prepared).toEqual([])

    await db.close()
  })

  it('should reject delete where(...).all() before connector preparation', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.delete(Users).where(Users.id, 'eq', 1).all()

    await expect(query.execute()).rejects.toMatchObject({
      _tag: 'QueryError',
      message: expect.stringContaining('cannot combine where(...) and .all()') as unknown,
    })

    expect(connector.prepared).toEqual([])

    await db.close()
  })
})

describe('CRUD input validation: should reject an empty delete predicate with a tagged error before connector preparation: should reject delete all().where(...) before connector preparation', () => {
  it('should reject delete all().where(...) before connector preparation', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.delete(Users).all().where(Users.id, 'eq', 1)

    await expect(query.execute()).rejects.toMatchObject({
      _tag: 'QueryError',
      message: expect.stringContaining('cannot combine where(...) and .all()') as unknown,
    })

    expect(connector.prepared).toEqual([])

    await db.close()
  })
})

describe('CRUD returning types', () => {
  it('should narrow insert.returning to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db
      .insert(Users)
      .values({ email: 'a@b.com' })
      .returning([Users.id, Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]

    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
    expectTypeOf<Row>().not.toHaveProperty('displayName')
    expectTypeOf<Row>().not.toHaveProperty('active')
  })

  it('should narrow update.returning to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db
      .update(Users)
      .set({ displayName: 'X' })
      .where(Users.id, 'eq', 1)
      .returning([Users.id])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]

    expectTypeOf<Row>().toEqualTypeOf<{ id: number }>()
  })

  it('should narrow delete.returning to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.delete(Users).where({ id: 1 }).returning([Users.email])
    type Row = Awaited<ReturnType<typeof query.execute>>[number]

    expectTypeOf<Row>().toEqualTypeOf<{ email: string }>()
  })
})

describe('CRUD safety and validation', () => {
  it('should reject update without where unless .all()', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.update(Users).set({ displayName: 'x' }).compile()).toThrow(QueryError)

    expect(() => db.update(Users).set({ displayName: 'x' }).compile()).toThrow(
      /where|\.all\(\)/i,
    )

    const ok = db.update(Users).set({ displayName: 'x' }).all().compile()
    expect(ok.sql.toLowerCase()).toContain('update')
    expect(ok.sql.toLowerCase()).not.toContain('where')

    await db.close()
  })

  it('should reject delete without where unless .all()', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.delete(Users).compile()).toThrow(QueryError)

    const ok = db.delete(Users).all().compile()
    expect(ok.sql.toLowerCase()).toContain('delete from')

    await db.close()
  })
})

describe('CRUD safety and validation: should reject invalid insert with ValidationError before SQL', () => {
  it('should reject invalid insert with ValidationError before SQL', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() =>
      db
        .insert(Users)
        .values({ email: 123 as never })
        .compile(),
    ).toThrow(ValidationError)

    expect(connector.prepared).toHaveLength(0)

    await db.close()
  })

  it('should reject always-generated columns on insert', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [AlwaysId] })

    expect(() =>
      db
        .insert(AlwaysId)
        .values({ id: 1, label: 'x' } as never)
        .compile(),
    ).toThrow(ValidationError)

    expect(() =>
      db
        .insert(AlwaysId)
        .values({ id: 1, label: 'x' } as never)
        .compile(),
    ).toThrow(/non-insertable|unknown/i)

    const ok = db.insert(AlwaysId).values({ label: 'x' }).compile()
    expect(ok.sql.toLowerCase()).toContain('insert')
    expect(ok.params).toEqual(['x'])

    await db.close()
  })
})

describe('CRUD safety and validation: should require bare nullable columns on insert but accept null', () => {
  it('should require bare nullable columns on insert but accept null', async () => {
    const WithNullable = defineTable(
      'with_nullable',
      {
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        note: nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
      },
      { primaryKey: 'id' },
    )

    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [WithNullable] })

    expect(() =>
      db
        .insert(WithNullable)
        .values({} as never)
        .compile(),
    ).toThrow(ValidationError)

    const withNull = db.insert(WithNullable).values({ note: null }).compile()
    expect(withNull.sql.toLowerCase()).toContain('insert')
    expect(withNull.params).toEqual([null])

    const withValue = db.insert(WithNullable).values({ note: 'hi' }).compile()
    expect(withValue.params).toEqual(['hi'])

    await db.close()
  })
})

describe('CRUD safety and validation: should require bare nullable columns on insert but accept null: should accept omitted and null nested wrapper values', () => {
  it('should accept omitted and null nested wrapper values', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [NestedWrappers] })

    const omitted = db.insert(NestedWrappers).values({ id: '1' }).compile()
    expect(omitted.params).toEqual(['1'])

    const withNull = db
      .insert(NestedWrappers)
      .values({ id: '1', optionalNullable: null, nullableOptional: null })
      .compile()

    expect(withNull.params).toEqual(['1', null, null])

    const withValues = db
      .insert(NestedWrappers)
      .values({ id: '1', optionalNullable: 'a', nullableOptional: 'b' })
      .compile()

    expect(withValues.params).toEqual(['1', 'a', 'b'])

    const updateWithNull = db
      .update(NestedWrappers)
      .set({ optionalNullable: null, nullableOptional: null })
      .where({ id: '1' })
      .compile()

    expect(updateWithNull.params).toEqual([null, null, '1'])

    const updateWithValues = db
      .update(NestedWrappers)
      .set({ optionalNullable: 'a', nullableOptional: 'b' })
      .where({ id: '1' })
      .compile()

    expect(updateWithValues.params).toEqual(['a', 'b', '1'])

    await db.close()
  })
})

describe('CRUD safety and validation: should reject invalid update patch', () => {
  it('should reject invalid update patch', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() =>
      db
        .update(Users)
        .set({ email: 9 as never })
        .where({ id: 1 })
        .compile(),
    ).toThrow(ValidationError)

    expect(connector.prepared).toHaveLength(0)

    await db.close()
  })
})

describe('CRUD execute terminals', () => {
  it('adds safe operation and target context to native write failures', async () => {
    const secret = 'secret-bound-value'
    const nativeCause = Object.assign(new Error(`native failure: ${secret}`), {
      code: '23505',
    })

    const connector = createFailingWriteConnector(nativeCause)

    const db = createDatabase({ connector, schemas: [Users] })

    const failures = await Promise.all([
      captureWriteFailure(() => db.insert(Users).values({ email: secret }).execute()),
      captureWriteFailure(() =>
        db.update(Users).set({ email: secret }).where(Users.id, 'eq', 1).execute(),
      ),
    ])

    expect(failures).toHaveLength(2)
    expectWriteFailure(failures[0], 'insert into', secret, nativeCause)
    expectWriteFailure(failures[1], 'update', secret, nativeCause)

    await db.close()
  })

  it('should return full rows by default when calling insert.values().execute', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: 'Ada', active: true }]
    const connector = createMockConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => rows,
    })

    const db = createDatabase({ connector, schemas: [Users] })

    const result = await db.insert(Users).values({ email: 'a@b.com' }).execute()
    expect(result).toEqual(rows)

    expect(connector.prepared.some((s) => /returning \*/i.test(s))).toBe(true)

    await db.close()
  })

  it('should return full rows when calling insert.returningAll().execute', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: 'Ada', active: true }]
    const connector = createMockConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => rows,
    })

    const db = createDatabase({ connector, schemas: [Users] })

    await expect(
      db.insert(Users).values({ email: 'a@b.com' }).returningAll().execute(),
    ).resolves.toEqual(rows)

    expect(connector.prepared.some((s) => /insert/i.test(s))).toBe(true)

    await db.close()
  })
})

describe('CRUD execute terminals: should return rows when calling executeTakeFirst on update/delete', () => {
  it('should return rows when calling executeTakeFirst on update/delete', async () => {
    const row = { id: 1, email: 'a@b.com', displayName: 'Z', active: true }
    const connector = createMockConnector({
      /** Supplies native result rows for the value-mapping scenario. */
      rowsBySql: () => [row],
    })

    const db = createDatabase({ connector, schemas: [Users] })

    await expect(
      db
        .update(Users)
        .set({ displayName: 'Z' })
        .where(Users.id, 'eq', 1)
        .executeTakeFirst(),
    ).resolves.toEqual(row)

    await expect(
      db.delete(Users).where({ id: 1 }).executeTakeFirstOrThrow(),
    ).resolves.toEqual(row)

    await db.close()
  })
})

/**
 * Removes required fields from otherwise valid values and checks that insert validation
 * rejects each omission.
 *
 * @param complete - Complete valid insert values from which required-column cases are
 *   derived.
 * @param db - Database client exercised by this test scenario.
 */
function assertRequiredInsertValues(complete: WrapperInsertValues, db: Db) {
  const { undefinedValue: _undefinedValue, ...withoutUndefinedValue } = complete
  void _undefinedValue

  expect(() =>
    db
      .insert(WrapperBehavior)
      .values(withoutUndefinedValue as never)
      .compile(),
  ).toThrow(/undefinedValue/)

  const { nonOptionalValue: _nonOptionalValue, ...withoutNonOptionalValue } = complete
  void _nonOptionalValue

  expect(() =>
    db
      .insert(WrapperBehavior)
      .values(withoutNonOptionalValue as never)
      .compile(),
  ).toThrow(/nonOptionalValue/)

  const { nonNullableValue: _nonNullableValue, ...withoutNonNullableValue } = complete
  void _nonNullableValue

  expect(() =>
    db
      .insert(WrapperBehavior)
      .values(withoutNonNullableValue as never)
      .compile(),
  ).toThrow(/nonNullableValue/)

  const { nonNullishValue: _nonNullishValue, ...withoutNonNullishValue } = complete
  void _nonNullishValue

  expect(() =>
    db
      .insert(WrapperBehavior)
      .values(withoutNonNullishValue as never)
      .compile(),
  ).toThrow(/nonNullishValue/)
}

type WrapperInsertValues = {
  id: string
  undefinedValue: string
  nullableValue: null
  nullishValue: string
  nonOptionalValue: string
  nonNullableValue: string
  nonNullishValue: string
}
