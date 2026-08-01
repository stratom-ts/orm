import {
  array,
  bigint,
  boolean,
  date,
  enum as enumSchema,
  integer,
  length,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  picklist,
  pipe,
  record,
  string,
  union,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import type { CreateTableAst, CreateTableColumnAst } from '@/index'
import { SchemaError, postgresDialect } from '@/index'
import type { Executor } from '@/query'

function createTable(...columns: CreateTableColumnAst[]): CreateTableAst {
  return {
    kind: 'create_table',
    table: 't',
    columns,
    primaryKey: ['id'],
  }
}

function col(
  name: string,
  overrides: Partial<CreateTableColumnAst> = {},
): CreateTableColumnAst {
  return {
    name,
    dataType: 'text',
    notNull: false,
    unique: false,
    autoIncrement: false,
    ...overrides,
  }
}

const { inferColumnType, compile } = postgresDialect

describe('@/dialects/postgres', () => {
  describe('normalizeDataType', () => {
    it('should keep real and double precision distinct', () => {
      expect(postgresDialect.normalizeDataType('float4')).toBe('real')
      expect(postgresDialect.normalizeDataType('real')).toBe('real')
      expect(postgresDialect.normalizeDataType('float8')).toBe('double precision')
      expect(postgresDialect.normalizeDataType('double precision')).toBe(
        'double precision',
      )
    })
  })

  describe('inferColumnType - string schemas', () => {
    it('should return text for string schema without constraints', () => {
      expect(inferColumnType(string())).toBe('text')
    })

    it('should return varchar with maxLength for string with maxLength <= 255', () => {
      expect(inferColumnType(pipe(string(), maxLength(100)))).toBe('varchar(100)')
    })

    it('should return text for string with maxLength > 255', () => {
      expect(inferColumnType(pipe(string(), maxLength(500)))).toBe('text')
    })

    it('should return varchar (not char) for fixed length string', () => {
      expect(inferColumnType(pipe(string(), length(10)))).toBe('varchar(10)')
    })

    it('should return varchar for string with both minLength and maxLength within 255', () => {
      expect(inferColumnType(pipe(string(), minLength(5), maxLength(10)))).toBe(
        'varchar(10)',
      )
    })
  })

  describe('inferColumnType - number schemas', () => {
    it('should return double precision for a plain number (JS numbers are doubles)', () => {
      expect(inferColumnType(number())).toBe('double precision')
    })

    it('should return double precision for a bounded but non-integer number', () => {
      // No integer() → a float in the range is valid, so it must not narrow.
      expect(inferColumnType(pipe(number(), minValue(0), maxValue(100)))).toBe(
        'double precision',
      )
    })

    it('should default integer() to integer', () => {
      expect(inferColumnType(pipe(number(), integer()))).toBe('integer')
    })

    it('should keep integer for a single-sided bound within int32', () => {
      expect(inferColumnType(pipe(number(), integer(), maxValue(1000000)))).toBe(
        'integer',
      )
    })

    it('should narrow to smallint only when both bounds fit int16', () => {
      expect(
        inferColumnType(pipe(number(), integer(), minValue(0), maxValue(32767))),
      ).toBe('smallint')
    })

    it('should widen to bigint when a bound falls outside int32', () => {
      expect(
        inferColumnType(
          pipe(number(), integer(), minValue(-10000000000), maxValue(10000000000)),
        ),
      ).toBe('bigint')
    })
  })

  describe('inferColumnType - literal schemas', () => {
    it('should return text for string literal', () => {
      expect(inferColumnType(literal('active'))).toBe('text')
    })

    it('should return integer for integer literal', () => {
      expect(inferColumnType(literal(42))).toBe('integer')
    })

    it('should return double precision for float literal', () => {
      expect(inferColumnType(literal(3.14))).toBe('double precision')
    })

    it('should return boolean for boolean literal', () => {
      expect(inferColumnType(literal(true))).toBe('boolean')
    })
  })

  describe('inferColumnType - other types', () => {
    it('should return timestamptz for date schema', () => {
      expect(inferColumnType(date())).toBe('timestamptz')
    })

    it('should return bigint for bigint schema', () => {
      expect(inferColumnType(bigint())).toBe('bigint')
    })

    it('should return boolean for boolean schema', () => {
      expect(inferColumnType(boolean())).toBe('boolean')
    })

    it('should return text for enum schema', () => {
      const DirectionEnum = { Left: 'LEFT', Right: 'RIGHT' } as const
      expect(inferColumnType(enumSchema(DirectionEnum))).toBe('text')
    })

    it('should return text for picklist schema', () => {
      expect(inferColumnType(picklist(['active', 'inactive', 'pending']))).toBe('text')
    })

    it('should return jsonb for object schemas', () => {
      expect(inferColumnType(object({ a: string(), b: number() }))).toBe('jsonb')
    })

    it('should return jsonb for array schemas', () => {
      expect(inferColumnType(array(string()))).toBe('jsonb')
    })

    it('should return jsonb for record schemas', () => {
      expect(inferColumnType(record(string(), number()))).toBe('jsonb')
    })

    it('should throw for a schema type it cannot map', () => {
      const schema = union([string(), number()])

      expect(() => inferColumnType(schema)).toThrow(SchemaError)
      expect(() => inferColumnType(schema)).toThrow(/cannot infer a SQL column type/)
    })
  })

  describe('ddl safety — type validation via compile', () => {
    it('should accept common types and normalize casing', () => {
      const sql = compile(
        createTable(
          col('a', { dataType: 'text' }),
          col('b', { dataType: 'UUID' }),
          col('c', { dataType: 'varchar(255)' }),
          col('d', { dataType: 'numeric(10, 2)' }),
          col('e', { dataType: 'timestamp with time zone' }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('"a" text')
      expect(sql).toContain('"b" uuid')
      expect(sql).toContain('"c" varchar(255)')
      expect(sql).toContain('"d" numeric(10,2)')
      expect(sql).toContain('"e" timestamp with time zone')
    })

    it('should reject SQL injection in data type', () => {
      expect(() =>
        compile(createTable(col('x', { dataType: 'text; drop table users' }))),
      ).toThrow(/unsafe/)
    })

    it('should reject semicolon-comment injection', () => {
      expect(() =>
        compile(createTable(col('x', { dataType: 'varchar(255);--' }))),
      ).toThrow()
    })

    it('should reject empty data type', () => {
      expect(() => compile(createTable(col('x', { dataType: '' })))).toThrow()
    })

    it('should reject unknown data type', () => {
      expect(() => compile(createTable(col('x', { dataType: 'foobar' })))).toThrow(
        /unsupported/,
      )
    })

    it('should reject via alter_column_type path', () => {
      expect(() =>
        compile({
          kind: 'alter_column_type',
          table: 't',
          column: 'x',
          dataType: 'evil(); drop table x',
        }),
      ).toThrow(/unsafe|unsupported/)
    })

    it('should accept valid type via alter_column_type path', () => {
      const sql = compile({
        kind: 'alter_column_type',
        table: 't',
        column: 'x',
        dataType: 'integer',
      }).sql.toLowerCase()

      expect(sql).toContain('type integer')
    })

    it('should reject via add_column path', () => {
      expect(() =>
        compile({
          kind: 'add_column',
          table: 't',
          column: col('x', { dataType: 'text; drop table y' }),
        }),
      ).toThrow(/unsafe/)
    })
  })

  describe('projection validation', () => {
    it('should reject empty select and returning AST projections', () => {
      expect(() => compile({ kind: 'select', table: 't', selection: [] })).toThrow(
        /select items must not be empty/,
      )

      expect(() =>
        compile({
          kind: 'insert',
          table: 't',
          columns: ['id'],
          values: [[1]],
          returning: { kind: 'columns', columns: [] },
        }),
      ).toThrow(/returning columns must not be empty/)
    })
  })

  describe('ddl safety — default value formatting via compile', () => {
    it('should emit now() unquoted in default', () => {
      const sql = compile(
        createTable(
          col('id', { dataType: 'uuid' }),
          col('ts', { dataType: 'timestamptz', defaultValue: 'now()' }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('default now()')
      expect(sql).not.toContain("default 'now()'")
    })

    it('should emit gen_random_uuid() unquoted', () => {
      const sql = compile(
        createTable(col('id', { dataType: 'uuid', defaultValue: 'gen_random_uuid()' })),
      ).sql.toLowerCase()

      expect(sql).toContain('default gen_random_uuid()')
    })

    it('should emit current_timestamp unquoted', () => {
      const sql = compile(
        createTable(
          col('ts', { dataType: 'timestamptz', defaultValue: 'current_timestamp' }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('default current_timestamp')
    })

    it('should case-insensitively match allowlisted expressions', () => {
      const sql = compile(
        createTable(col('ts', { dataType: 'timestamptz', defaultValue: 'NOW()' })),
      ).sql.toLowerCase()

      expect(sql).toContain('default now()')
    })

    it('should emit null, true, false as SQL literals', () => {
      const sql = compile(
        createTable(
          col('a', { dataType: 'text', defaultValue: null }),
          col('b', { dataType: 'boolean', defaultValue: true }),
          col('c', { dataType: 'boolean', defaultValue: false }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('default null')
      expect(sql).toContain('default true')
      expect(sql).toContain('default false')
    })

    it('should emit numeric defaults as literals', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'integer', defaultValue: 42 })),
      ).sql.toLowerCase()

      expect(sql).toContain('default 42')
    })

    it('should escape single quotes in string defaults', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'text', defaultValue: "O'Brien" })),
      ).sql

      expect(sql).toContain("default 'O''Brien'")
    })

    it('should quote unknown string defaults to prevent SQL execution', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'text', defaultValue: 'drop table users' })),
      ).sql

      expect(sql).toContain("default 'drop table users'")
    })

    it('should quote strings that look like injection attempts', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'text', defaultValue: 'now(); select 1' })),
      ).sql

      expect(sql).toContain("default 'now(); select 1'")
    })
  })

  describe('introspect', () => {
    it('rejects an unresolved writable namespace instead of defaulting to public', async () => {
      const executor: Executor = {
        async execute() {
          return []
        },
        async run() {},
      }

      await expect(postgresDialect.introspect(executor)).rejects.toThrow(
        /could not resolve a writable namespace/i,
      )
    })

    it('should normalize catalog rows into a public snapshot', async () => {
      const executor: Executor = {
        async execute({ sql }) {
          if (sql.includes('current_database()')) {
            return [{ database: 'test', schema: 'public' }]
          }
          if (
            sql.includes('information_schema.tables') &&
            !sql.includes('information_schema.columns')
          ) {
            return [
              { schema: 'public', name: 'accounts' },
              { schema: 'app', name: 'events' },
              {},
            ]
          }
          if (sql.includes('information_schema.columns')) {
            return [
              {
                schema: 'public',
                table_name: 'accounts',
                column_name: 'id',
                data_type: 'integer',
                udt_name: 'int4',
                is_nullable: 'NO',
                is_identity: 'YES',
                identity_generation: 'ALWAYS',
              },
              {
                schema: 'public',
                table_name: 'accounts',
                column_name: 'email',
                data_type: 'character varying',
                character_maximum_length: '255',
                column_default: "(('new'::text))",
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'code',
                data_type: 'character',
                udt_name: 'bpchar',
                character_maximum_length: 8,
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'amount',
                data_type: 'numeric',
                numeric_precision: '10',
                numeric_scale: '2',
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'created_at',
                data_type: 'timestamp with time zone',
                udt_name: 'timestamptz',
                column_default: '(now())',
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'label',
                data_type: 'text',
                column_default: "('a') || ('b')",
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'status',
                data_type: 'text',
                column_default: "'hello'::text::varchar",
              },
              { table_name: 1, column_name: 'ignored' },
            ]
          }
          if (sql.includes('pg_index')) {
            return [
              {
                schema: 'public',
                table_name: 'accounts',
                index_name: 'accounts_email_idx',
                is_unique: 'YES',
                columns: '{email}',
              },
              {
                schema: 'app',
                table_name: 'events',
                index_name: 'events_invalid_idx',
                is_unique: 0,
                columns: '[invalid json]',
              },
              { table_name: 'accounts' },
            ]
          }
          if (sql.includes('pg_constraint')) {
            return [
              {
                schema: 'public',
                table_name: 'accounts',
                constraint_name: 'accounts_pkey',
                constraint_type: 'p',
                columns: '{id}',
              },
              {
                schema: 'public',
                table_name: 'accounts',
                constraint_name: 'accounts_email_key',
                constraint_type: 'u',
                columns: '["email",1]',
              },
              {
                schema: 'app',
                table_name: 'events',
                constraint_name: 'events_account_fkey',
                constraint_type: 'f',
                columns: ['account_id', 1],
                referenced_schema: 'public',
                referenced_table: 'accounts',
                referenced_columns: '{id}',
                on_delete: 'cascade',
                on_update: 'restrict',
              },
              { table_name: 'accounts' },
            ]
          }
          return []
        },
        async run() {},
      }

      const snapshot = await postgresDialect.introspect(executor)

      expect(snapshot.tables).toEqual([
        {
          name: 'accounts',
          schema: 'public',
          columns: [
            {
              name: 'id',
              dataType: 'integer',
              isNullable: false,
              hasDefault: false,
              isIdentity: true,
              defaultExpression: null,
              identityGeneration: 'always',
            },
            {
              name: 'email',
              dataType: 'varchar(255)',
              isNullable: true,
              hasDefault: true,
              isIdentity: false,
              defaultExpression: "'new'",
              identityGeneration: null,
            },
          ],
          indexes: [{ name: 'accounts_email_idx', columns: ['email'], unique: true }],
          primaryKey: { name: 'accounts_pkey', columns: ['id'] },
          uniqueConstraints: [{ name: 'accounts_email_key', columns: ['email'] }],
          foreignKeys: [],
        },
        {
          name: 'events',
          schema: 'app',
          columns: [
            expect.objectContaining({ name: 'code', dataType: 'char(8)' }),
            expect.objectContaining({ name: 'amount', dataType: 'numeric(10,2)' }),
            expect.objectContaining({
              name: 'created_at',
              dataType: 'timestamptz',
              defaultExpression: 'now()',
            }),
            expect.objectContaining({
              name: 'label',
              defaultExpression: "('a') || ('b')",
            }),
            expect.objectContaining({
              name: 'status',
              defaultExpression: "'hello'",
            }),
          ],
          indexes: [{ name: 'events_invalid_idx', columns: [], unique: false }],
          primaryKey: null,
          uniqueConstraints: [],
          foreignKeys: [
            {
              name: 'events_account_fkey',
              columns: ['account_id'],
              referencedSchema: 'public',
              referencedTable: 'accounts',
              referencedColumns: ['id'],
              onDelete: 'cascade',
              onUpdate: 'restrict',
            },
          ],
        },
      ])
      expect(snapshot.namespaceContext).toEqual({
        writableDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'public' },
        ],
      })
    })

    it('keeps dotted schema and relation tuples distinct during introspection', async () => {
      const executor: Executor = {
        async execute({ sql }) {
          if (sql.includes('current_database()')) {
            return [{ database: 'test', schema: 'public' }]
          }
          if (
            sql.includes('information_schema.tables') &&
            !sql.includes('information_schema.columns')
          ) {
            return [
              { schema: 'a.b', name: 'c' },
              { schema: 'a', name: 'b.c' },
            ]
          }
          if (sql.includes('information_schema.columns')) {
            return [
              {
                schema: 'a.b',
                table_name: 'c',
                column_name: 'schema_marker',
                data_type: 'text',
                is_nullable: 'NO',
              },
              {
                schema: 'a',
                table_name: 'b.c',
                column_name: 'relation_marker',
                data_type: 'text',
                is_nullable: 'NO',
              },
            ]
          }
          return []
        },
        async run() {},
      }

      const snapshot = await postgresDialect.introspect(executor)

      expect(
        snapshot.tables.map((table) => ({
          schema: table.schema,
          name: table.name,
          columns: table.columns.map((column) => column.name),
        })),
      ).toEqual([
        { schema: 'a.b', name: 'c', columns: ['schema_marker'] },
        { schema: 'a', name: 'b.c', columns: ['relation_marker'] },
      ])
    })
  })
})
