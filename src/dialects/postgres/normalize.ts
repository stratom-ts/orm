/**
 * Normalizes PostgreSQL type names and aliases for comparison.
 *
 * @param dataType - Raw type string (e.g. `int4`, `character varying`)
 *
 * @returns Canonical type (e.g. `integer`, `varchar`)
 *
 * @example```ts
 * normalizePostgresDataType('int4')                // 'integer'
 * normalizePostgresDataType('character varying')   // 'varchar'
 * normalizePostgresDataType('varchar(255)')        // 'varchar(255)'
 * ```
 */
export function normalizePostgresDataType(dataType: string): string {
  const normalized = dataType.toLowerCase().trim()
  const typeMappings: Record<string, string> = {
    bool: 'boolean',
    boolean: 'boolean',
    int4: 'integer',
    integer: 'integer',
    int2: 'smallint',
    smallint: 'smallint',
    int8: 'bigint',
    bigint: 'bigint',
    float8: 'double precision',
    float4: 'real',
    real: 'real',
    doubleprecision: 'double precision',
    'double precision': 'double precision',
    timestamptz: 'timestamptz',
    timestamp: 'timestamp',
    timestampwithouttimezone: 'timestamp',
    timestampwithtimezone: 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    char: 'char',
    character: 'char',
    'character varying': 'varchar',
    varchar: 'varchar',
    text: 'text',
    uuid: 'uuid',
    json: 'json',
    jsonb: 'jsonb',
  }
  const withoutLength = normalized.replace(/\(\d+\)/, '').trim()
  const lengthMatch = normalized.match(/\((\d+)\)/)
  if (typeMappings[withoutLength]) {
    return lengthMatch
      ? `${typeMappings[withoutLength]}(${lengthMatch[1]})`
      : typeMappings[withoutLength]
  }
  return normalized
}

/**
 * Extracts the base PostgreSQL type without length/precision suffix.
 *
 * @param dataType - SQL data type string (e.g. `varchar(255)`, `numeric(10,2)`)
 *
 * @returns Base type name (e.g. `varchar`, `numeric`)
 *
 * @example```ts
 * postgresBaseType('varchar(255)')   // 'varchar'
 * postgresBaseType('numeric(10,2)')  // 'numeric'
 * postgresBaseType('text')           // 'text'
 * ```
 */
export function postgresBaseType(dataType: string): string {
  return normalizePostgresDataType(dataType).replace(/\(.*\)$/, '')
}
