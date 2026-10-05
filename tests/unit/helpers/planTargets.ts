import type {
  CanonicalIdentifier,
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  MigrationColumnReference,
  MigrationColumnTarget,
  MigrationIndexTarget,
  MigrationNamespaceTarget,
  MigrationRelationTarget,
} from '@/index'

const DEFAULT_DATABASE = 'test'

/** PostgreSQL compares identifiers exactly, so fixtures reuse their spelling. */
export function identifier(spelling: string): CanonicalIdentifier {
  return { spelling, comparisonKey: spelling }
}

/** Builds structured PostgreSQL namespace segments for the fixture database and schema. */
export function namespace(
  schema: string,
  database = DEFAULT_DATABASE,
): readonly CanonicalNamespaceSegment[] {
  return [
    { role: 'database', identifier: identifier(database) },
    { role: 'schema', identifier: identifier(schema) },
  ]
}

/** Builds a structured canonical relation identity for the fixture. */
export function relation(
  schema: string,
  table: string,
  database = DEFAULT_DATABASE,
): CanonicalRelationIdentity {
  return { namespace: namespace(schema, database), relation: identifier(table) }
}

/** Builds a namespace Migration Target with structured identity segments. */
export function namespaceTarget(
  schema: string,
  database = DEFAULT_DATABASE,
): MigrationNamespaceTarget {
  return { kind: 'namespace', namespace: namespace(schema, database) }
}

/** Builds a relation Migration Target with structured identity segments. */
export function relationTarget(
  schema: string,
  table: string,
  database = DEFAULT_DATABASE,
): MigrationRelationTarget {
  return { kind: 'relation', relation: relation(schema, table, database) }
}

/** Builds a column Migration Target with its owning relation identity. */
export function columnTarget(
  schema: string,
  table: string,
  column: string,
  database = DEFAULT_DATABASE,
): MigrationColumnTarget {
  return {
    kind: 'column',
    relation: relation(schema, table, database),
    column: identifier(column),
  }
}

/** Builds an index Migration Target with its owning relation identity. */
export function indexTarget(
  schema: string,
  table: string,
  index: string,
  database = DEFAULT_DATABASE,
): MigrationIndexTarget {
  return {
    kind: 'index',
    relation: relation(schema, table, database),
    index: identifier(index),
  }
}

/** Finds column reference evidence in the source syntax tree. */
export function columnReference(
  schema: string,
  table: string,
  column: string,
  actions?: { onDelete?: string; onUpdate?: string },
): MigrationColumnReference {
  return {
    relation: relation(schema, table),
    column: identifier(column),
    ...(actions?.onDelete === undefined ? {} : { onDelete: actions.onDelete }),
    ...(actions?.onUpdate === undefined ? {} : { onUpdate: actions.onUpdate }),
  }
}

/** Converts authored column spellings into ordered fixture identifiers. */
export function columnIdentifiers(
  ...columns: readonly string[]
): readonly CanonicalIdentifier[] {
  return columns.map(identifier)
}
