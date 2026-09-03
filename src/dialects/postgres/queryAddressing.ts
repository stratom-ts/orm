import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type { DialectQueryResolveOptions } from '../types'

import { compilePostgres, createPostgresQueryRelationResolver } from './compile'

/**
 * Finds registered table handles that address the same PostgreSQL query relation.
 *
 * Omitted qualification remains distinct until session evidence resolves it.
 *
 * @param handles - Registered handles available to the current query path.
 * @param relation - Authored relation intent to resolve.
 */
type SessionRequirement = Readonly<{
  database?: string
  schema?: string
}>

/** Finds the session evidence needed for two authored relations to coincide. */
function postgresRelationSessionRequirement(
  left: ReturnType<ReturnType<typeof createPostgresQueryRelationResolver>>,
  right: ReturnType<ReturnType<typeof createPostgresQueryRelationResolver>>,
): SessionRequirement | undefined {
  if (left.table !== right.table) return undefined

  if (
    left.database !== undefined &&
    right.database !== undefined &&
    left.database !== right.database
  ) {
    return undefined
  }

  if (
    left.schema !== undefined &&
    right.schema !== undefined &&
    left.schema !== right.schema
  ) {
    return undefined
  }

  return {
    ...(left.database === undefined && right.database !== undefined
      ? { database: right.database }
      : right.database === undefined && left.database !== undefined
        ? { database: left.database }
        : {}),
    ...(left.schema === undefined && right.schema !== undefined
      ? { schema: right.schema }
      : right.schema === undefined && left.schema !== undefined
        ? { schema: left.schema }
        : {}),
  }
}

function findPostgresQueryRelationMatches(
  handles: readonly TableHandle[],
  relation: RelationIdentityInput,
  resolveRelation: ReturnType<typeof createPostgresQueryRelationResolver>,
): readonly Readonly<{ handle: TableHandle; requirement: SessionRequirement }>[] {
  const expected = resolveRelation(relation)

  return handles.flatMap((handle) => {
    const candidate = resolveRelation(handle.getTableMetadata().relation)
    const requirement = postgresRelationSessionRequirement(candidate, expected)
    return requirement === undefined ? [] : [{ handle, requirement }]
  })
}

/**
 * Finds registered table columns that address the same PostgreSQL member spelling.
 *
 * PostgreSQL query compilation quotes authored identifiers, so query-time member
 * addressing remains exact.
 *
 * @param handle - Table handle whose schema columns should be searched.
 * @param column - Authored column spelling to resolve.
 */
function findPostgresQueryColumnMatches(
  handle: TableHandle,
  column: string,
): readonly string[] {
  return Object.keys(handle.getSchema().entries).filter(
    (candidate) => candidate === column,
  )
}

/** Creates one coherent PostgreSQL Query resolution for a client registry. */
export function resolvePostgresQuery(
  handles: readonly TableHandle[],
  options?: DialectQueryResolveOptions,
) {
  const registered = [...handles]
  const requirements = new Map<string, SessionRequirement>()
  const resolveRelation = createPostgresQueryRelationResolver(
    options?.registrationDefault,
  )

  return Object.freeze({
    compile(node: Parameters<typeof compilePostgres>[0]) {
      const compiled = compilePostgres(node, resolveRelation)
      if (requirements.size === 0) return compiled

      return {
        ...compiled,
        assertSession(
          identity: Parameters<NonNullable<typeof compiled.assertSession>>[0],
        ) {
          compiled.assertSession?.(identity)
          const namespace = identity.namespaceContext?.writableDefault
          const database =
            namespace?.find((segment) => segment.role === 'database')?.spelling ??
            identity.database
          const schema = namespace?.find((segment) => segment.role === 'schema')?.spelling

          for (const requirement of requirements.values()) {
            if (requirement.database !== undefined && requirement.database !== database) {
              throw new QueryError({
                message: `PostgreSQL query database ${JSON.stringify(requirement.database)} does not match executing database ${JSON.stringify(database)}`,
              })
            }

            if (requirement.schema !== undefined && requirement.schema !== schema) {
              throw new QueryError({
                message: `PostgreSQL query schema ${JSON.stringify(requirement.schema)} does not match executing current schema ${JSON.stringify(schema)}`,
              })
            }
          }
        },
      }
    },
    findRelationMatches(
      relation: RelationIdentityInput,
      candidates?: readonly TableHandle[],
    ) {
      return findPostgresQueryRelationMatches(
        candidates ?? registered,
        relation,
        resolveRelation,
      ).map(({ handle, requirement }) => {
        if (
          candidates === undefined &&
          (requirement.database !== undefined || requirement.schema !== undefined)
        ) {
          requirements.set(JSON.stringify(requirement), requirement)
        }

        return handle
      })
    },
    findColumnMatches: findPostgresQueryColumnMatches,
  })
}
