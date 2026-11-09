type FixtureTable = {
  schema: string
  name: string
  columns: {
    name: string
    dataType: string
    isNullable: boolean
    defaultExpression?: string | null
  }[]
  primaryKey?: string[]
  uniqueConstraints?: { name: string; columns: string[] }[]
  indexes?: { name: string; columns: string[]; unique: boolean }[]
  foreignKeys?: {
    name: string
    columns: string[]
    referencedSchema?: string
    referencedTable: string
    referencedColumns: string[]
    onDelete?: string
    onUpdate?: string
  }[]
}

const identifier = '"((?:[^"]|"")+)"'
const qualified = `${identifier}\\.${identifier}`
const unquote = (name: string) => name.replaceAll('""', '"')
const names = (text: string) =>
  [...text.matchAll(/"((?:[^"]|"")+)"/g)].map((match) => unquote(match[1]))

/** Applies the DDL subset used by controlled migration fixtures to observed state. */
function applyPostgresFixtureDdl(sql: string, tables: FixtureTable[]): void {
  const create = new RegExp(`^create table ${qualified} \\((.*)\\)$`, 'i').exec(sql)

  if (create) {
    tables.push(parseCreateTable(create[1], create[2], create[3]))

    return
  }

  applyAlter(sql, tables)

  const index = new RegExp(
    `^create (unique )?index ${identifier} on ${qualified} \\(([^)]+)\\)`,
    'i',
  ).exec(sql)

  if (index) {
    const table = tables.find(
      (table) => table.schema === index[3] && table.name === index[4],
    )

    if (table) {
      const indexes = (table.indexes ??= [])
      indexes.push({
        name: index[2],
        columns: names(index[5]),
        unique: !!index[1],
      })
    }
  }

  const dropTable = new RegExp(`^drop table ${qualified}`, 'i').exec(sql)

  if (dropTable) {
    const position = tables.findIndex(
      (table) => table.schema === dropTable[1] && table.name === dropTable[2],
    )

    if (position >= 0) tables.splice(position, 1)
  }

  const dropIndex = new RegExp(`^drop index ${qualified}`, 'i').exec(sql)

  if (dropIndex) {
    for (const table of tables)
      table.indexes = table.indexes?.filter((index) => index.name !== dropIndex[2])
  }
}

/** Reads the columns, primary key, and inline unique constraints of a create table. */
function parseCreateTable(schema: string, name: string, body: string): FixtureTable {
  const definitions = [
    ...body.matchAll(/(?:^|, )"((?:[^"]|"")+)" ([a-z]+(?:\([\d, ]+\))?)([^,]*)/gi),
  ]

  const columns = definitions.map((match) => ({
    name: unquote(match[1]),
    dataType: match[2],
    isNullable: !/not null/i.test(match[3]),
    defaultExpression: /default (.*)/i.exec(match[3])?.[1] ?? null,
  }))

  const tableName = unquote(name)

  const uniqueConstraints = definitions.flatMap((match) =>
    inlineUniqueConstraint(tableName, match),
  )

  const primary = /primary key \(([^)]+)\)/i.exec(body)

  return {
    schema: unquote(schema),
    name: tableName,
    columns,
    ...(primary ? { primaryKey: names(primary[1]) } : {}),
    ...(uniqueConstraints.length ? { uniqueConstraints } : {}),
  }
}

/** Reads a column's inline unique clause, naming it as PostgreSQL does when unnamed. */
function inlineUniqueConstraint(table: string, definition: RegExpMatchArray) {
  const attributes = definition[3].split(/ (?:default|references) /i)[0]
  const named = new RegExp(`constraint ${identifier} unique\\b`, 'i').exec(attributes)

  if (!named && !/\bunique\b/i.test(attributes)) return []

  const column = unquote(definition[1])

  return [
    { name: named ? unquote(named[1]) : `${table}_${column}_key`, columns: [column] },
  ]
}

/** Applies fixture column and constraint changes. */
function applyAlter(sql: string, tables: FixtureTable[]): void {
  const alter = new RegExp(`^alter table ${qualified} (.*)$`, 'i').exec(sql)

  if (alter) {
    const table = tables.find(
      (table) => table.schema === alter[1] && table.name === alter[2],
    )

    if (!table) return

    const unique = /^add constraint "([^"]+)" unique \(([^)]+)\)/i.exec(alter[3])

    if (unique) {
      const constraints = (table.uniqueConstraints ??= [])
      constraints.push({
        name: unique[1],
        columns: names(unique[2]),
      })
    }

    const foreign = new RegExp(
      `^add constraint ${identifier} foreign key \\(([^)]+)\\) references ${qualified} \\(([^)]+)\\)(.*)$`,
      'i',
    ).exec(alter[3])

    if (foreign) {
      const keys = (table.foreignKeys ??= [])
      keys.push({
        name: foreign[1],
        columns: names(foreign[2]),
        referencedSchema: foreign[3],
        referencedTable: foreign[4],
        referencedColumns: names(foreign[5]),
        onDelete:
          /on delete (cascade|restrict|set null|set default|no action)/i
            .exec(foreign[6])?.[1]
            ?.toLowerCase() ?? 'no action',
        onUpdate:
          /on update (cascade|restrict|set null|set default|no action)/i
            .exec(foreign[6])?.[1]
            ?.toLowerCase() ?? 'no action',
      })
    }

    const drop = /^drop column "([^"]+)"/i.exec(alter[3])

    if (drop) table.columns = table.columns.filter((column) => column.name !== drop[1])

    const rename = new RegExp(`^rename column ${identifier} to ${identifier}$`, 'i').exec(
      alter[3],
    )

    if (rename) renameColumn(tables, table, unquote(rename[1]), unquote(rename[2]))
  }
}

/** Moves a column name through local members and inbound foreign-key references. */
function renameColumn(
  tables: FixtureTable[],
  table: FixtureTable,
  from: string,
  to: string,
): void {
  const rename = (columns: string[]) => columns.map((name) => (name === from ? to : name))

  for (const column of table.columns) if (column.name === from) column.name = to

  if (table.primaryKey) table.primaryKey = rename(table.primaryKey)

  for (const member of [
    ...(table.uniqueConstraints ?? []),
    ...(table.indexes ?? []),
    ...(table.foreignKeys ?? []),
  ])
    member.columns = rename(member.columns)

  for (const key of tables.flatMap((other) => other.foreignKeys ?? [])) {
    if (
      (key.referencedSchema ?? 'public') === table.schema &&
      key.referencedTable === table.name
    )
      key.referencedColumns = rename(key.referencedColumns)
  }
}

/** Returns catalog rows for tables created by controlled session tests. */
function postgresFixtureCatalogRows(
  sql: string,
  tables: FixtureTable[],
): unknown[] | undefined {
  if (/-- catalog:namespace/i.test(sql) && tables.length) {
    return [...new Set(tables.map((table) => table.schema))].map((schema) => ({
      schema,
      owner: 'app',
    }))
  }

  if (/as relation_kind/i.test(sql)) return relationRows(tables)

  if (/-- catalog:column/i.test(sql)) return columnRows(tables)

  if (/con.contype as constraint_type/i.test(sql)) return constraintRows(tables)

  return undefined
}

/** Projects primary, unique, and foreign-key constraints for the controlled provider. */
function constraintRows(tables: FixtureTable[]) {
  return tables.flatMap((table) => [
    ...(table.primaryKey
      ? [
          keyConstraintRow(
            table,
            `${table.name}_pkey`,
            'p',
            table.primaryKey,
            `primary key (${table.primaryKey.join(', ')})`,
          ),
        ]
      : []),
    ...(table.uniqueConstraints ?? []).map((constraint) =>
      keyConstraintRow(
        table,
        constraint.name,
        'u',
        constraint.columns,
        `unique (${constraint.columns.join(', ')})`,
      ),
    ),
    ...(table.foreignKeys ?? []).map((constraint) => ({
      schema: table.schema,
      table_name: table.name,
      constraint_name: constraint.name,
      constraint_type: 'f',
      columns: constraint.columns,
      referenced_schema: constraint.referencedSchema ?? 'public',
      referenced_table: constraint.referencedTable,
      referenced_columns: constraint.referencedColumns,
      on_delete: constraint.onDelete ?? 'no action',
      on_update: constraint.onUpdate ?? 'no action',
      is_valid: true,
      is_deferrable: false,
      initially_deferred: false,
      match_type: 's',
      has_column_specific_delete_action: false,
      native_definition: `foreign key (${constraint.columns.join(', ')}) references ${constraint.referencedTable}`,
    })),
  ])
}

/** Projects one primary or unique key constraint row. */
function keyConstraintRow(
  table: FixtureTable,
  name: string,
  type: 'p' | 'u',
  columns: string[],
  definition: string,
) {
  return {
    schema: table.schema,
    table_name: table.name,
    constraint_name: name,
    constraint_type: type,
    columns,
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    backing_index_is_valid: true,
    has_supported_backing_index_semantics: true,
    backing_index_nulls_not_distinct: false,
    native_definition: definition,
  }
}

/** Projects ordinary table inventory for the controlled provider. */
function relationRows(tables: FixtureTable[]) {
  return tables.map((table) => ({
    object_id: `${table.schema}.${table.name}`,
    schema: table.schema,
    name: table.name,
    relation_kind: 'r',
    persistence: 'p',
    owner: 'app',
    can_inspect: true,
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
  }))
}

/** Projects observed column facts for the controlled provider. */
function columnRows(tables: FixtureTable[]) {
  return tables.flatMap((table) =>
    table.columns.map((column, index) => ({
      schema: table.schema,
      table_name: table.name,
      column_name: column.name,
      ordinal_position: index + 1,
      data_type: column.dataType,
      udt_name: column.dataType,
      is_user_defined: false,
      character_maximum_length: null,
      numeric_precision: null,
      numeric_scale: null,
      is_nullable: column.isNullable ? 'YES' : 'NO',
      column_default: column.defaultExpression ?? null,
      is_identity: 'NO',
      identity_generation: null,
      is_generated: 'NEVER',
      generation_expression: null,
    })),
  )
}

export { applyPostgresFixtureDdl, postgresFixtureCatalogRows }
