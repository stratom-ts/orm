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

export function namespace(
  schema: string,
  database = DEFAULT_DATABASE,
): readonly CanonicalNamespaceSegment[] {
  return [
    { role: 'database', identifier: identifier(database) },
    { role: 'schema', identifier: identifier(schema) },
  ]
}

export function relation(
  schema: string,
  table: string,
  database = DEFAULT_DATABASE,
): CanonicalRelationIdentity {
  return { namespace: namespace(schema, database), relation: identifier(table) }
}

export function namespaceTarget(
  schema: string,
  database = DEFAULT_DATABASE,
): MigrationNamespaceTarget {
  return { kind: 'namespace', namespace: namespace(schema, database) }
}

export function relationTarget(
  schema: string,
  table: string,
  database = DEFAULT_DATABASE,
): MigrationRelationTarget {
  return { kind: 'relation', relation: relation(schema, table, database) }
}

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

export function columnIdentifiers(
  ...columns: readonly string[]
): readonly CanonicalIdentifier[] {
  return columns.map(identifier)
}
