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
const names = (text: string) =>
  [...text.matchAll(/"((?:[^"]|"")+)"/g)].map((match) => match[1].replaceAll('""', '"'))

/** Applies the DDL subset used by controlled migration fixtures to observed state. */
function applyPostgresFixtureDdl(sql: string, tables: FixtureTable[]): void {
  const create = new RegExp(`^create table ${qualified} \\((.*)\\)$`, 'i').exec(sql)

  if (create) {
    const [, schema, name, body] = create
    const columns = [
      ...body.matchAll(/(?:^|, )"((?:[^"]|"")+)" ([a-z]+(?:\([\d, ]+\))?)([^,]*)/gi),
    ].map((match) => ({
      name: match[1].replaceAll('""', '"'),
      dataType: match[2],
      isNullable: !/not null/i.test(match[3]),
      defaultExpression: /default (.*)/i.exec(match[3])?.[1] ?? null,
    }))

    const primary = /primary key \(([^)]+)\)/i.exec(body)
    tables.push({
      schema: schema.replaceAll('""', '"'),
      name: name.replaceAll('""', '"'),
      columns,
      ...(primary ? { primaryKey: names(primary[1]) } : {}),
    })

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

    if (table)
      (table.indexes ??= []).push({
        name: index[2],
        columns: names(index[5]),
        unique: !!index[1],
      })
  }

  const dropTable = new RegExp(`^drop table ${qualified}`, 'i').exec(sql)

  if (dropTable) {
    const position = tables.findIndex(
      (table) => table.schema === dropTable[1] && table.name === dropTable[2],
    )

    if (position >= 0) tables.splice(position, 1)
  }

  const dropIndex = new RegExp(`^drop index ${qualified}`, 'i').exec(sql)

  if (dropIndex)
    for (const table of tables)
      table.indexes = table.indexes?.filter((index) => index.name !== dropIndex[2])
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

    if (unique)
      (table.uniqueConstraints ??= []).push({
        name: unique[1],
        columns: names(unique[2]),
      })

    const foreign = new RegExp(
      `^add constraint ${identifier} foreign key \\(([^)]+)\\) references ${qualified} \\(([^)]+)\\)(.*)$`,
      'i',
    ).exec(alter[3])

    if (foreign)
      (table.foreignKeys ??= []).push({
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

    const drop = /^drop column "([^"]+)"/i.exec(alter[3])

    if (drop) table.columns = table.columns.filter((column) => column.name !== drop[1])
  }
}

/** Returns catalog rows for tables created by controlled session tests. */
function postgresFixtureCatalogRows(
  sql: string,
  tables: FixtureTable[],
): unknown[] | undefined {
  if (/-- catalog:namespace/i.test(sql) && tables.length)
    return [...new Set(tables.map((table) => table.schema))].map((schema) => ({
      schema,
      owner: 'app',
    }))

  if (/as relation_kind/i.test(sql)) return relationRows(tables)

  if (/-- catalog:column/i.test(sql)) return columnRows(tables)

  if (/con.contype as constraint_type/i.test(sql))
    return tables.flatMap((table) =>
      table.primaryKey
        ? [
            {
              schema: table.schema,
              table_name: table.name,
              constraint_name: `${table.name}_pkey`,
              constraint_type: 'p',
              columns: table.primaryKey,
              is_valid: true,
              is_deferrable: false,
              initially_deferred: false,
              backing_index_is_valid: true,
              has_supported_backing_index_semantics: true,
              backing_index_nulls_not_distinct: false,
              native_definition: `primary key (${table.primaryKey.join(', ')})`,
            },
          ]
        : [],
    )

  return undefined
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
