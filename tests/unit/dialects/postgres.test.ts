import {
  array,
  bigint,
  boolean,
  date,
  enum as enumSchema,
  exactOptional,
  integer,
  length,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  number,
  object,
  picklist,
  pipe,
  record,
  string,
  undefinedable,
  union,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { compilePostgres } from '@/dialects/postgres/compile'
import type {
  PostgresCreateTableAst as CreateTableAst,
  PostgresCreateTableColumnAst as CreateTableColumnAst,
} from '@/dialects/postgres/migration/ast'
import type { CatalogRequest, CatalogSnapshot } from '@/index'
import { SchemaError, postgresDialect } from '@/index'
import type { Executor } from '@/query'

const catalogRequest = (
  ...relations: Array<{ schema: string; table: string }>
): CatalogRequest => ({
  relations: relations.map(({ schema, table }) => ({
    relation: {
      namespace: [{ role: 'schema', spelling: schema }],
      relation: table,
    },
    shape: 'complete',
  })),
  absentRelations: [],
  completeNamespaces: [],
})

function catalogFixtureView(snapshot: CatalogSnapshot) {
  const tables = snapshot.namespaces.items.flatMap((namespace) =>
    namespace.relations.items.flatMap((relation) => {
      if (relation.table.state !== 'present') return []
      const table = relation.table.value
      const schema = relation.identity.namespace.find(({ role }) => role === 'schema')!
        .identifier.spelling
      const key = (constraint: (typeof table.uniqueConstraints.items)[number]) => ({
        name: constraint.name.state === 'present' ? constraint.name.value : '',
        columns: [...constraint.columns],
        semanticCompleteness:
          constraint.semantics.state === 'present' ? 'supportedSimple' : 'unsupported',
        isValid:
          constraint.validity.state === 'present' &&
          constraint.validity.value === 'valid',
      })
      return [
        {
          name: relation.identity.relation.spelling,
          schema,
          columns: table.columns.items.map((column) => ({
            name: column.name,
            dataType:
              column.dataType.state === 'present' ? column.dataType.value.native : '',
            isNullable: column.nullable.state === 'present' && column.nullable.value,
            hasDefault: column.default.state === 'present',
            isIdentity: column.generation.state === 'present',
            defaultExpression:
              column.default.state === 'present' &&
              column.default.value.comparisonKey.state === 'present'
                ? column.default.value.comparisonKey.value
                : null,
            identityGeneration:
              column.generation.state === 'present' &&
              column.generation.value.kind === 'identity'
                ? column.generation.value.mode
                : null,
          })),
          indexes: table.indexes.items.map((index) => ({
            name: index.name.state === 'present' ? index.name.value : '',
            columns: [...index.columns],
            unique: index.unique,
            semanticCompleteness:
              index.semantics.state === 'present' ? 'supportedSimple' : 'unsupported',
            isValid:
              index.validity.state === 'present' && index.validity.value === 'valid',
          })),
          primaryKey:
            table.primaryKey.state === 'present' ? key(table.primaryKey.value) : null,
          uniqueConstraints: table.uniqueConstraints.items.map(key),
          foreignKeys: table.foreignKeys.items.map((foreignKey) => ({
            ...key(foreignKey),
            referencedSchema: foreignKey.referencedRelation.namespace.find(
              ({ role }) => role === 'schema',
            )!.identifier.spelling,
            referencedTable: foreignKey.referencedRelation.relation.spelling,
            referencedColumns: [...foreignKey.referencedColumns],
            onDelete: foreignKey.onDelete,
            onUpdate: foreignKey.onUpdate,
          })),
        },
      ]
    }),
  )
  tables.sort((left, right) => compareCodeUnits(right.schema, left.schema))
  return {
    tables,
    namespaceContext: snapshot.namespaceContext,
    nameReservations: snapshot.nameReservations.items.map((reservation) => ({
      schema: reservation.namespace.find(({ role }) => role === 'schema')!.identifier
        .spelling,
      name: reservation.name,
    })),
    constraintNameReservations: snapshot.constraintNameReservations.items.map(
      (reservation) => ({
        schema: reservation.relation.namespace.find(({ role }) => role === 'schema')!
          .identifier.spelling,
        table: reservation.relation.relation.spelling,
        name: reservation.name,
      }),
    ),
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function createTable(...columns: CreateTableColumnAst[]): CreateTableAst {
  return {
    kind: 'create_table',
    table: 't',
    schema: 'public',
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

const { inferColumnType } = postgresDialect.schema
const compile = compilePostgres

describe('@/dialects/postgres', () => {
  describe('normalizeDataType', () => {
    it('should keep real and double precision distinct', () => {
      expect(postgresDialect.schema.normalizeDataType('float4')).toBe('real')
      expect(postgresDialect.schema.normalizeDataType('real')).toBe('real')
      expect(postgresDialect.schema.normalizeDataType('float8')).toBe('double precision')
      expect(postgresDialect.schema.normalizeDataType('double precision')).toBe(
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

    it('should preserve constraints through every wrapper family', () => {
      const schemas = [
        exactOptional(pipe(string(), maxLength(40))),
        undefinedable(pipe(string(), maxLength(40))),
        nonOptional(pipe(string(), maxLength(40))),
        nonNullable(pipe(string(), maxLength(40))),
        nonNullish(pipe(string(), maxLength(40))),
      ]

      for (const schema of schemas) expect(inferColumnType(schema)).toBe('varchar(40)')
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
          schema: 'public',
          column: 'x',
          dataType: 'evil(); drop table x',
        }),
      ).toThrow(/unsafe|unsupported/)
    })

    it('should accept valid type via alter_column_type path', () => {
      const sql = compile({
        kind: 'alter_column_type',
        table: 't',
        schema: 'public',
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
          schema: 'public',
          column: col('x', { dataType: 'text; drop table y' }),
        }),
      ).toThrow(/unsafe/)
    })
  })

  describe('projection validation', () => {
    it('should reject empty select and returning AST projections', () => {
      expect(() =>
        compile({ kind: 'select', relation: { relation: 't' }, selection: [] }),
      ).toThrow(/select items must not be empty/)

      expect(() =>
        compile({
          kind: 'insert',
          relation: { relation: 't' },
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

    it('should prefer pre-normalized database defaults during compilation', () => {
      const sql = compile(
        createTable(
          col('n', {
            dataType: 'text',
            defaultValue: 'legacy',
            databaseDefault: {
              sql: "E'path\\\\'",
              normalized: "E'path\\\\'",
            },
          }),
        ),
      ).sql

      expect(sql).toContain("default E'path\\\\'")
      expect(sql).not.toContain('legacy')
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

      await expect(
        postgresDialect.catalog.introspectCatalog(executor, catalogRequest()),
      ).rejects.toThrow(/could not resolve a writable namespace/i)
    })

    it('should normalize catalog rows into a public snapshot', async () => {
      const executedSql: string[] = []
      const executor: Executor = {
        async execute({ sql }) {
          executedSql.push(sql)

          if (sql.includes('current_database()')) {
            return [{ database: 'test', schema: 'public', version: '160000' }]
          }

          if (sql.includes('-- catalog:namespace')) {
            return [
              { schema: 'public', owner: 'app' },
              { schema: 'app', owner: 'app' },
            ]
          }

          if (sql.includes('as relation_kind')) {
            return [
              {
                object_id: '1',
                schema: 'public',
                name: 'accounts',
                relation_kind: 'r',
                persistence: 'p',
                owner: 'app',
                native_definition: null,
                options: [],
                partition_key: null,
                row_level_security: false,
                force_row_level_security: false,
                replica_identity: 'd',
                access_method: 'heap',
                tablespace: null,
                is_partition: false,
                partition_bound: null,
              },
              {
                object_id: '2',
                schema: 'app',
                name: 'events',
                relation_kind: 'r',
                persistence: 'p',
                owner: 'app',
                native_definition: null,
                options: [],
                partition_key: null,
                row_level_security: false,
                force_row_level_security: false,
                replica_identity: 'd',
                access_method: 'heap',
                tablespace: null,
                is_partition: false,
                partition_bound: null,
              },
            ]
          }

          if (sql.includes('-- catalog:column')) {
            return [
              {
                schema: 'public',
                table_name: 'accounts',
                column_name: 'id',
                ordinal_position: 1,
                data_type: 'integer',
                udt_name: 'int4',
                is_user_defined: false,
                is_nullable: 'NO',
                column_default: null,
                is_identity: 'YES',
                identity_generation: 'ALWAYS',
                is_generated: 'NEVER',
                generation_expression: null,
              },
              {
                schema: 'public',
                table_name: 'accounts',
                column_name: 'email',
                ordinal_position: 2,
                data_type: 'character varying',
                udt_name: 'varchar',
                is_user_defined: false,
                character_maximum_length: '255',
                numeric_precision: null,
                numeric_scale: null,
                is_nullable: 'YES',
                column_default: "(('new'::text))",
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'code',
                ordinal_position: 1,
                data_type: 'character',
                udt_name: 'bpchar',
                is_user_defined: false,
                character_maximum_length: 8,
                numeric_precision: null,
                numeric_scale: null,
                is_nullable: 'YES',
                column_default: null,
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'amount',
                ordinal_position: 2,
                data_type: 'numeric',
                udt_name: 'numeric',
                is_user_defined: false,
                character_maximum_length: null,
                numeric_precision: '10',
                numeric_scale: '2',
                is_nullable: 'YES',
                column_default: null,
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'created_at',
                ordinal_position: 3,
                data_type: 'timestamp with time zone',
                udt_name: 'timestamptz',
                is_user_defined: false,
                character_maximum_length: null,
                numeric_precision: null,
                numeric_scale: null,
                is_nullable: 'YES',
                column_default: '(now())',
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'label',
                ordinal_position: 4,
                data_type: 'text',
                udt_name: 'text',
                is_user_defined: false,
                character_maximum_length: null,
                numeric_precision: null,
                numeric_scale: null,
                is_nullable: 'YES',
                column_default: "('a') || ('b')",
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
              {
                schema: 'app',
                table_name: 'events',
                column_name: 'status',
                ordinal_position: 5,
                data_type: 'text',
                udt_name: 'text',
                is_user_defined: false,
                character_maximum_length: null,
                numeric_precision: null,
                numeric_scale: null,
                is_nullable: 'YES',
                column_default: "'hello'::text::varchar",
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
            ]
          }

          if (sql.includes('from pg_index i')) {
            return [
              {
                schema: 'public',
                table_name: 'accounts',
                index_name: 'accounts_email_idx',
                is_unique: 'YES',
                columns: '{email}',
                has_supported_semantics: true,
                is_valid: true,
                nulls_not_distinct: false,
                native_definition:
                  'create unique index accounts_email_idx on public.accounts (email)',
              },
              {
                schema: 'app',
                table_name: 'events',
                index_name: 'events_invalid_idx',
                is_unique: 0,
                columns: '{code}',
                has_supported_semantics: true,
                is_valid: false,
                nulls_not_distinct: false,
                native_definition: 'create index events_invalid_idx on app.events (code)',
              },
              {
                schema: 'public',
                table_name: 'accounts',
                index_name: 'accounts_email_nnd_idx',
                is_unique: true,
                columns: '{email}',
                has_supported_semantics: true,
                is_valid: true,
                nulls_not_distinct: true,
                native_definition:
                  'create unique index accounts_email_nnd_idx on public.accounts (email) nulls not distinct',
              },
            ]
          }

          if (sql.includes('from pg_constraint con')) {
            return [
              {
                schema: 'public',
                table_name: 'accounts',
                constraint_name: 'accounts_pkey',
                constraint_type: 'p',
                columns: '{id}',
                is_valid: true,
                is_deferrable: false,
                initially_deferred: false,
                backing_index_is_valid: true,
                has_supported_backing_index_semantics: true,
                backing_index_nulls_not_distinct: false,
                native_definition: 'primary key (id)',
              },
              {
                schema: 'public',
                table_name: 'accounts',
                constraint_name: 'accounts_email_key',
                constraint_type: 'u',
                columns: '["email"]',
                is_valid: true,
                is_deferrable: false,
                initially_deferred: false,
                backing_index_is_valid: true,
                has_supported_backing_index_semantics: true,
                backing_index_nulls_not_distinct: false,
                native_definition: 'unique (email)',
              },
              {
                schema: 'public',
                table_name: 'accounts',
                constraint_name: 'accounts_email_nnd_key',
                constraint_type: 'u',
                columns: '{email}',
                is_valid: true,
                is_deferrable: false,
                initially_deferred: false,
                backing_index_is_valid: true,
                has_supported_backing_index_semantics: true,
                backing_index_nulls_not_distinct: true,
                native_definition: 'unique nulls not distinct (email)',
              },
              {
                schema: 'public',
                table_name: 'accounts',
                constraint_name: 'accounts_email_include_key',
                constraint_type: 'u',
                columns: '{email}',
                is_valid: true,
                is_deferrable: false,
                initially_deferred: false,
                backing_index_is_valid: true,
                has_supported_backing_index_semantics: false,
                backing_index_nulls_not_distinct: false,
                native_definition: 'unique (email) include (id)',
              },
              {
                schema: 'app',
                table_name: 'events',
                constraint_name: 'events_account_fkey',
                constraint_type: 'f',
                columns: ['account_id'],
                referenced_schema: 'public',
                referenced_table: 'accounts',
                referenced_columns: '{id}',
                on_delete: 'cascade',
                on_update: 'restrict',
                is_valid: true,
                is_deferrable: false,
                initially_deferred: false,
                match_type: 's',
                has_column_specific_delete_action: false,
                native_definition:
                  'foreign key (account_id) references public.accounts(id)',
              },
              {
                schema: 'public',
                table_name: 'accounts',
                constraint_name: 'accounts_email_check',
                constraint_type: 'c',
                columns: '{email}',
                is_valid: true,
                is_deferrable: false,
                initially_deferred: false,
                native_definition: 'check (email is not null)',
              },
            ]
          }

          if (sql.includes('c.relname as object_name')) {
            return [
              { schema: 'public', object_name: 'accounts' },
              { schema: 'public', object_name: 'reserved_sequence' },
              { schema: 'public', object_name: 'accounts_composite' },
              { schema: 'public', object_name: 'accounts_partitioned_index' },
              { schema: 'public', object_name: 'accounts_email_nnd_idx' },
              { schema: 'public', object_name: 'accounts_email_nnd_key' },
              { schema: 'public', object_name: 'accounts_email_include_key' },
            ]
          }

          return []
        },
        async run() {},
      }

      const observed = await postgresDialect.catalog.introspectCatalog(
        executor,
        catalogRequest(
          { schema: 'public', table: 'accounts' },
          { schema: 'app', table: 'events' },
        ),
      )
      const snapshot = catalogFixtureView(observed)

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
          indexes: [
            {
              name: 'accounts_email_idx',
              columns: ['email'],
              unique: true,
              semanticCompleteness: 'supportedSimple',
              isValid: true,
            },
            {
              name: 'accounts_email_nnd_idx',
              columns: ['email'],
              unique: true,
              semanticCompleteness: 'unsupported',
              isValid: true,
            },
          ],
          primaryKey: {
            name: 'accounts_pkey',
            columns: ['id'],
            semanticCompleteness: 'supportedSimple',
            isValid: true,
          },
          uniqueConstraints: [
            {
              name: 'accounts_email_include_key',
              columns: ['email'],
              semanticCompleteness: 'unsupported',
              isValid: true,
            },
            {
              name: 'accounts_email_key',
              columns: ['email'],
              semanticCompleteness: 'supportedSimple',
              isValid: true,
            },
            {
              name: 'accounts_email_nnd_key',
              columns: ['email'],
              semanticCompleteness: 'unsupported',
              isValid: true,
            },
          ],
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
          indexes: [
            {
              name: 'events_invalid_idx',
              columns: ['code'],
              unique: false,
              semanticCompleteness: 'supportedSimple',
              isValid: false,
            },
          ],
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
              semanticCompleteness: 'supportedSimple',
              isValid: true,
            },
          ],
        },
      ])
      const accounts = snapshot.tables.find((table) => table.name === 'accounts')!
      expect(
        accounts.indexes?.find((index) => index.name === 'accounts_email_idx'),
      ).toMatchObject({ semanticCompleteness: 'supportedSimple' })
      expect(
        accounts.indexes?.find((index) => index.name === 'accounts_email_nnd_idx'),
      ).toMatchObject({ semanticCompleteness: 'unsupported' })
      expect(
        accounts.uniqueConstraints?.find(
          (constraint) => constraint.name === 'accounts_email_key',
        ),
      ).toMatchObject({ semanticCompleteness: 'supportedSimple' })
      expect(
        accounts.uniqueConstraints?.find(
          (constraint) => constraint.name === 'accounts_email_nnd_key',
        ),
      ).toMatchObject({ semanticCompleteness: 'unsupported' })
      expect(snapshot.namespaceContext).toEqual({
        writableDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'public' },
        ],
      })
      expect(snapshot.nameReservations).toEqual(
        expect.arrayContaining([
          { schema: 'public', name: 'accounts' },
          { schema: 'public', name: 'reserved_sequence' },
          { schema: 'public', name: 'accounts_composite' },
          { schema: 'public', name: 'accounts_partitioned_index' },
          { schema: 'public', name: 'accounts_email_nnd_idx' },
          { schema: 'public', name: 'accounts_email_nnd_key' },
          { schema: 'public', name: 'accounts_email_include_key' },
        ]),
      )
      expect(snapshot.nameReservations).toHaveLength(7)
      expect(snapshot.constraintNameReservations).toEqual(
        expect.arrayContaining([
          { schema: 'public', table: 'accounts', name: 'accounts_pkey' },
          { schema: 'public', table: 'accounts', name: 'accounts_email_key' },
          { schema: 'public', table: 'accounts', name: 'accounts_email_nnd_key' },
          { schema: 'public', table: 'accounts', name: 'accounts_email_include_key' },
          { schema: 'app', table: 'events', name: 'events_account_fkey' },
          { schema: 'public', table: 'accounts', name: 'accounts_email_check' },
        ]),
      )
      expect(snapshot.constraintNameReservations).toHaveLength(6)
      const reservationSql = executedSql.find((sql) =>
        sql.includes('c.relname as object_name'),
      )
      expect(reservationSql).toBeDefined()
      expect(reservationSql).not.toContain('relkind in')
      const indexSql = executedSql.find((sql) => sql.includes('from pg_index i'))
      expect(indexSql).toContain('i.indpred is null')
      expect(indexSql).toContain('i.indexprs is null')
      expect(indexSql).toContain('i.indnkeyatts = i.indnatts')
      expect(indexSql).toContain('unnest(i.indoption)')
      expect(indexSql).toContain('unnest(i.indclass)')
      expect(indexSql).toContain('unnest(i.indcollation, i.indkey)')
      expect(indexSql).toContain("to_jsonb(i) ->> 'indnullsnotdistinct'")
      expect(indexSql).not.toContain('i.indnullsnotdistinct')
      const constraintSql = executedSql.find((sql) =>
        sql.includes('from pg_constraint con'),
      )
      expect(constraintSql).toContain('con.conindid')
      expect(constraintSql).toContain("to_jsonb(backing_index) ->> 'indnullsnotdistinct'")
      expect(constraintSql).toContain(
        "jsonb_typeof(to_jsonb(con) -> 'confdelsetcols') = 'array'",
      )
      expect(constraintSql).not.toContain('backing_index.indnullsnotdistinct')
      expect(constraintSql).toContain(
        'backing_index.indnkeyatts = backing_index.indnatts',
      )
      const columnSql = executedSql.find((sql) => sql.includes('-- catalog:column'))
      expect(columnSql).not.toContain('information_schema.columns')
      const opaqueSql = executedSql.find((sql) => sql.includes('from pg_policy'))
      expect(opaqueSql).toContain('p.polpermissive')
      expect(opaqueSql).toContain('p.polcmd')
      expect(opaqueSql).toContain('p.polroles')
    })

    it('keeps dotted schema and relation tuples distinct during introspection', async () => {
      const executor: Executor = {
        async execute({ sql }) {
          if (sql.includes('current_database()')) {
            return [{ database: 'test', schema: 'public', version: '160000' }]
          }

          if (sql.includes('-- catalog:namespace')) {
            return [
              { schema: 'a.b', owner: 'app' },
              { schema: 'a', owner: 'app' },
            ]
          }

          if (sql.includes('as relation_kind')) {
            return [
              {
                object_id: '1',
                schema: 'a.b',
                name: 'c',
                relation_kind: 'r',
                persistence: 'p',
                owner: 'app',
                native_definition: null,
                options: [],
                partition_key: null,
                row_level_security: false,
                force_row_level_security: false,
                replica_identity: 'd',
                access_method: 'heap',
                tablespace: null,
                is_partition: false,
                partition_bound: null,
              },
              {
                object_id: '2',
                schema: 'a',
                name: 'b.c',
                relation_kind: 'r',
                persistence: 'p',
                owner: 'app',
                native_definition: null,
                options: [],
                partition_key: null,
                row_level_security: false,
                force_row_level_security: false,
                replica_identity: 'd',
                access_method: 'heap',
                tablespace: null,
                is_partition: false,
                partition_bound: null,
              },
            ]
          }

          if (sql.includes('-- catalog:column')) {
            return [
              {
                schema: 'a.b',
                table_name: 'c',
                column_name: 'schema_marker',
                ordinal_position: 1,
                data_type: 'text',
                udt_name: 'text',
                is_user_defined: false,
                is_nullable: 'NO',
                column_default: null,
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
              {
                schema: 'a',
                table_name: 'b.c',
                column_name: 'relation_marker',
                ordinal_position: 1,
                data_type: 'text',
                udt_name: 'text',
                is_user_defined: false,
                is_nullable: 'NO',
                column_default: null,
                is_identity: 'NO',
                identity_generation: null,
                is_generated: 'NEVER',
                generation_expression: null,
              },
            ]
          }

          return []
        },
        async run() {},
      }

      const snapshot = catalogFixtureView(
        await postgresDialect.catalog.introspectCatalog(
          executor,
          catalogRequest({ schema: 'a.b', table: 'c' }, { schema: 'a', table: 'b.c' }),
        ),
      )

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

    it('rejects foreign keys with unresolved referenced relation metadata', async () => {
      const executor: Executor = {
        async execute({ sql }) {
          if (sql.includes('current_database()')) {
            return [{ database: 'test', schema: 'public', version: '160000' }]
          }

          if (sql.includes('-- catalog:namespace')) {
            return [{ schema: 'public', owner: 'app' }]
          }

          if (sql.includes('as relation_kind')) {
            return [
              {
                object_id: '1',
                schema: 'public',
                name: 'events',
                relation_kind: 'r',
                persistence: 'p',
                owner: 'app',
                native_definition: null,
                options: [],
                partition_key: null,
                row_level_security: false,
                force_row_level_security: false,
                replica_identity: 'd',
                access_method: 'heap',
                tablespace: null,
                is_partition: false,
                partition_bound: null,
              },
            ]
          }

          if (sql.includes('pg_constraint')) {
            return [
              {
                schema: 'public',
                table_name: 'events',
                constraint_name: 'events_owner_fkey',
                constraint_type: 'f',
                columns: ['owner_id'],
                referenced_columns: ['id'],
                is_valid: true,
                is_deferrable: false,
                initially_deferred: false,
                match_type: 's',
                has_column_specific_delete_action: false,
                on_delete: 'no action',
                on_update: 'no action',
                native_definition: 'foreign key (owner_id) references owners(id)',
              },
            ]
          }

          return []
        },
        async run() {},
      }

      await expect(
        postgresDialect.catalog.introspectCatalog(
          executor,
          catalogRequest({ schema: 'public', table: 'events' }),
        ),
      ).rejects.toThrow(
        /foreign key "events_owner_fkey".*missing referenced relation metadata/i,
      )
    })
  })
})
