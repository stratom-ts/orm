import { baseTable, occurrenceAlias } from '@/defineTable'
import type {
  ComparisonOp,
  DeleteAst,
  Dialect,
  DialectQueryResolution,
  InsertAst,
  InsertConflictAst,
  JoinAst,
  OrderByAst,
  PredicateAst,
  QualifiedColumnAst,
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlExprAst,
  UpdateAst,
} from '@/dialects'
import { contextualOperationError } from '@/operations/errorContext'
import type { RelationIdentityInput } from '@/schemas'
import { getColumnMetadata } from '@/schemas'
import type { ColumnRef, Prettify, TableHandle } from '@/types'
import type {
  InferInsert,
  InferSelect,
  InferSelectAllSide,
  InferSelectedColumns,
  InferUpdate,
  MergeJoinStar,
  MergeSelection,
  NullableFields,
  RightJoinStarResult,
  TableIdentityOf,
} from '@/types/views'
import { InvariantError, QueryError } from '@/utils/error'

import { isAddition } from './arithmetic'
import type { UpdatePatch } from './arithmetic'
import { markCompiledQuery, restoreResultNames } from './compiled'
import type { CompiledQuery } from './compiled'
import type { Executor } from './executor'
import type { ExpressionBuilder } from './expressions'
import { and, cmp, columnName, columnRelation, eb, toQualified } from './expressions'
import { after, before } from './keyset'
import type { OrderTerm } from './keyset'
import type { ValueMapper } from './mapping'
import { recordQueryRelation } from './sourceRelation'
import type { WildcardProjection, projectionShape } from './subquery'
import { nestedDefinitions, selectDefinitions } from './subquery'
import type { ExcludedRef } from './upsert'
import { isExcludedRef } from './upsert'
import { buildInsertSchema, validateUpdatePatchWithStructuredValues } from './validate'

/** Result when a write runs without `returning`. */
export type WriteResult = {
  rowCount: number
}

/** Keeps count-only mode distinct from returned rows with a numeric rowCount column. */
declare const noReturning: unique symbol
type NoReturning = typeof noReturning

export type { CompiledQuery } from './compiled'

type WhereInput =
  | PredicateAst
  | ((builder: ExpressionBuilder) => PredicateAst)
  | Record<string, unknown>
  | [column: ColumnRef | string, op: ComparisonOp, value: unknown]

type JoinOnInput = PredicateAst | ((builder: ExpressionBuilder) => PredicateAst)

/** Extract the JS type from a ColumnRef. Falls back to `unknown` for bare strings. */
type InferColumnValue<T> =
  T extends ColumnRef<string, string, infer TType> ? TType : unknown

/**
 * Resolves a join predicate input.
 *
 * @param on - Predicate or predicate factory.
 */
function resolveOn(on: JoinOnInput): PredicateAst {
  return typeof on === 'function' ? on(eb) : on
}

/**
 * Maps value parameters through the mapper for join predicates.
 *
 * @example
 *   mapJoinsParams([handle], mapper, [{ type: 'inner', table: 'posts', on: ... }])
 *
 * @param handles - Table handles available to the joins.
 * @param mapper - Value mapper for parameter conversion.
 * @param joins - Join AST nodes to map.
 *
 * @returns Mapped join AST nodes, or the original when no mapper or joins
 */
function mapJoinsParams(
  query: DialectQueryResolution,
  handles: readonly TableHandle[],
  mapper: ValueMapper | undefined,
  joins: readonly JoinAst[] | undefined,
): readonly JoinAst[] | undefined {
  if (!joins || joins.length === 0) return joins

  return joins.map((join) => ({
    ...join,
    on: mapPredicateParams(query, handles, mapper, join.on)!,
  }))
}

/**
 * Converts a join type, table handle, and ON expression into a JoinAst node.
 *
 * @example
 *   toJoinAst('inner', PostTable, eq(PostTable.userId, UserTable.id))
 *
 * @param type - Join type (inner, left, right).
 * @param table - Table handle to join.
 * @param on - Join ON predicate or callback.
 *
 * @returns Join AST node
 */
function toJoinAst(type: JoinAst['type'], table: TableHandle, on: JoinOnInput): JoinAst {
  const info = table.getTableMetadata()
  recordQueryRelation(info.relation, table)
  return {
    type,
    relation: info.relation,
    on: resolveOn(on),
  }
}

/**
 * Checks whether a value is a predicate AST node.
 *
 * @param value - Value to inspect.
 */
function isPredicateAst(value: unknown): value is PredicateAst {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false

  const kind = (value as { kind?: unknown }).kind
  return (
    typeof kind === 'string' &&
    ['cmp', 'and', 'or', 'not', 'exists', 'inQuery', 'exprCmp'].includes(kind)
  )
}

/**
 * Normalizes supported where inputs into a predicate AST.
 *
 * @param input - Where input to normalize.
 */
function normalizeWhere(input: WhereInput): PredicateAst {
  if (typeof input === 'function') return input(eb)

  if (Array.isArray(input)) {
    const [column, op, value] = input
    return cmp(column, op, value)
  }

  if (isPredicateAst(input)) {
    return input
  }

  const entries = Object.entries(input)

  if (entries.length === 0) {
    throw new QueryError({ message: 'where({}) requires at least one key' })
  }

  const preds = entries.map(([column, value]) => cmp(column, 'eq', value))
  return preds.length === 1 ? preds[0]! : and(...preds)
}

/**
 * Combines an existing predicate with a new one using AND.
 *
 * @example
 *   mergeWhere(existingPred, newPred) // AND(existingPred, newPred)
 *   mergeWhere(undefined, newPred) // newPred
 *
 * @param existing - Existing predicate, or `undefined` if none.
 * @param next - New predicate to combine.
 *
 * @returns Combined predicate, or `next` when `existing` is undefined
 */
function mergeWhere(
  existing: PredicateAst | undefined,
  next: PredicateAst,
): PredicateAst {
  return existing ? and(existing, next) : next
}

/**
 * Resolves and validates returning column names.
 *
 * @param columns - Columns requested by a returning clause.
 */
function resolveReturningColumns(columns: readonly (ColumnRef | string)[]): string[] {
  if (columns.length === 0) {
    throw new QueryError({ message: 'returning(...) requires at least one column' })
  }

  return columns.map((c) => columnName(c))
}

type SelectSelectionInput =
  | readonly (ColumnRef | string)[]
  | ((
      builder: ExpressionBuilder,
    ) => readonly (
      | ColumnRef
      | string
      | { expr: SqlExprAst; alias: string }
      | SelectItemAst
    )[])

/**
 * Converts a column reference into a select item.
 *
 * @param column - Column to select.
 */
function selectionColumn(column: ColumnRef | string): SelectItemAst {
  const relation = columnRelation(column)
  return relation
    ? {
        kind: 'column',
        column: columnName(column),
        relation,
      }
    : { kind: 'column', column: columnName(column) }
}

/**
 * Normalizes and validates a select input.
 *
 * @param input - Selection list or selection factory.
 */
function normalizeSelection(input: SelectSelectionInput): SelectItemAst[] {
  let selection: SelectItemAst[]

  if (typeof input === 'function') {
    const items = input(eb)
    selection = items.map((item): SelectItemAst => {
      if (typeof item === 'string') {
        return { kind: 'column', column: item }
      }

      if ('kind' in item) {
        return item as SelectItemAst
      }

      if ('expr' in item && 'alias' in item) {
        return {
          kind: 'expr',
          expr: (item as { expr: SqlExprAst }).expr,
          alias: (item as { alias: string }).alias,
        }
      }

      return selectionColumn(item as ColumnRef)
    })
  } else {
    selection = input.map((c) => selectionColumn(c))
  }

  if (selection.length === 0) {
    throw new QueryError({ message: 'select(...) requires at least one item' })
  }

  return selection
}

/**
 * Maps write row parameters through the value mapper.
 *
 * @example
 *   mapWriteParams(handle, mapper, ['name', 'age'], [['Alice', 30]])
 *
 * @param handle - Table handle for column metadata.
 * @param mapper - Value mapper for parameter conversion.
 * @param columns - Column names corresponding to each value index.
 * @param values - Row values to map.
 *
 * @returns Mapped row values
 */
function mapWriteParams(
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  columns: readonly string[],
  values: readonly (readonly unknown[])[],
): readonly (readonly unknown[])[] {
  if (!mapper) return values

  return values.map((row) =>
    row.map((value, i) => {
      const col = columns[i]!
      return mapper.mapParam(handle, col, value)
    }),
  )
}

/**
 * Recursively maps predicate parameter values through the value mapper.
 *
 * @example
 *   mapPredicateParams([handle], mapper, cmp('name', 'eq', 'Alice'))
 *
 * @param handles - Table handles available to the predicate.
 * @param mapper - Value mapper for parameter conversion.
 * @param pred - Predicate AST node to map.
 *
 * @returns Mapped predicate, or the original when no mapper or predicate
 */
function mapPredicateParams(
  query: DialectQueryResolution,
  handles: readonly TableHandle[],
  mapper: ValueMapper | undefined,
  pred: PredicateAst | undefined,
): PredicateAst | undefined {
  if (!pred || !mapper) return pred

  switch (pred.kind) {
    case 'cmp': {
      // Column-vs-column join/on predicates have no bound params.
      if (pred.right || pred.value === null) return pred

      const handle = findHandle(query, handles, pred.relation)
      const column = findColumn(query, handle, pred.column, pred.relation)

      return {
        ...pred,
        value: mapper.mapParam(handle, column, pred.value),
      }
    }
    case 'and':
      return {
        kind: 'and',
        preds: pred.preds.map((p) => mapPredicateParams(query, handles, mapper, p)!),
      }
    case 'or':
      return {
        kind: 'or',
        preds: pred.preds.map((p) => mapPredicateParams(query, handles, mapper, p)!),
      }
    case 'not':
      return {
        kind: 'not',
        pred: mapPredicateParams(query, handles, mapper, pred.pred)!,
      }
    case 'exists':
    case 'inQuery':
    case 'exprCmp':
      return pred
    default: {
      const _exhaustive: never = pred
      return _exhaustive
    }
  }
}

/**
 * Formats authored relation intent for diagnostics.
 *
 * @param relation - Authored relation intent.
 */
function formatRelationInput(relation: RelationIdentityInput): string {
  const segments =
    relation.namespace?.map(
      ({ role, spelling }) => `${role}:${JSON.stringify(spelling)}`,
    ) ?? []

  segments.push(`relation:${JSON.stringify(relation.relation)}`)
  return `[${segments.join(', ')}]`
}

/**
 * Finds the unambiguous handle for a qualified table reference.
 *
 * @param query - Resolved query compilation and relation-member lookup operations.
 * @param handles - Table handles to search.
 * @param relation - Optional authored relation intent.
 *
 * @returns The uniquely matched registered table handle; absent or ambiguous matches
 *   throw.
 */
function findHandle(
  query: DialectQueryResolution,
  handles: readonly TableHandle[],
  relation: RelationIdentityInput | undefined,
): TableHandle {
  if (!relation) return handles[0]!

  const matches = occurrenceAlias(relation)
    ? handles.filter((h) => h.getTableMetadata().relation === relation)
    : query.findRelationMatches(
        relation,
        handles.filter((h) => !occurrenceAlias(h.getTableMetadata().relation)),
      )

  if (matches.length === 1) return matches[0]!

  if (matches.length === 0) {
    throw new QueryError({
      message: `query relation ${formatRelationInput(relation)} is not available in this query`,
    })
  }

  throw new QueryError({
    message: `query relation ${formatRelationInput(relation)} is ambiguous in this query`,
  })
}

/**
 * Finds the unambiguous column owned by a matched handle.
 *
 * @param query - Resolved query compilation and relation-member lookup operations.
 * @param handle - Handle whose columns are being addressed.
 * @param column - Authored column spelling to resolve.
 * @param relation - Optional authored relation for diagnostics.
 *
 * @returns The unambiguous column owned by a matched handle.
 */
function findColumn(
  query: DialectQueryResolution,
  handle: TableHandle,
  column: string,
  relation: RelationIdentityInput | undefined,
): string {
  const matches = query.findColumnMatches(handle, column)
  const target = relation
    ? `${formatRelationInput(relation)}.${column}`
    : `${handle.getTableMetadata().name}.${column}`

  if (matches.length === 1) return matches[0]!

  if (matches.length === 0) {
    throw new QueryError({
      message: `query column ${target} is not available in this query`,
    })
  }

  throw new QueryError({
    message: `query column ${target} is ambiguous in this query`,
  })
}

type ResultColumn = { handle: TableHandle; column: string; scalar?: boolean }

/**
 * Builds result-column mappings for a selection.
 *
 * @param handles - Table handles available to the selection.
 * @param selection - Selected AST items.
 */
function resultColumnsForSelection(
  query: DialectQueryResolution,
  handles: readonly TableHandle[],
  selection: readonly SelectItemAst[],
): Map<string, ResultColumn> {
  const columns = new Map<string, ResultColumn>()
  const outputNames = new Set<string>()
  /** Adds a selected output column while rejecting duplicate output names. */
  const add = (outputName: string, mapping?: ResultColumn) =>
    addOutputColumn(outputName, mapping, outputNames, columns)

  /** Adds source mappings for all columns on the selected table handles. */
  const addHandles = (selectedHandles: readonly TableHandle[]) => {
    for (const handle of selectedHandles) addAllOutputColumns(handle, add)
  }

  for (const item of selection) {
    if (item.kind === 'all') {
      const selectedHandles = item.relation
        ? [findHandle(query, handles, item.relation)]
        : handles

      addHandles(selectedHandles)
    } else if (item.kind === 'column') {
      const handle = findHandle(query, handles, item.relation)
      add(item.alias ?? item.column, {
        handle,
        column: findColumn(query, handle, item.column, item.relation),
      })
    } else {
      const expression = item.expr

      const handle =
        expression.kind === 'column'
          ? findHandle(query, handles, expression.relation)
          : undefined

      add(
        item.alias,
        handle && expression.kind === 'column'
          ? {
              handle,
              column: findColumn(query, handle, expression.column, expression.relation),
            }
          : undefined,
      )
    }
  }

  return columns
}

/**
 * Maps selected row values using their source-column mappings.
 *
 * @param mapper - Mapper used for result conversion.
 * @param rows - Rows to map.
 * @param columns - Output-to-source column mappings.
 */
function mapSelectedRows(
  mapper: ValueMapper,
  rows: unknown[],
  columns: ReadonlyMap<string, ResultColumn>,
): unknown[] {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row

    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        const mapping = columns.get(key)
        return [
          key,
          mapping && !(mapping.scalar && value === null)
            ? mapper.mapResultValue(baseTable(mapping.handle), mapping.column, value)
            : value,
        ]
      }),
    )
  })
}

/**
 * Compiles and executes a query AST, mapping result rows when a mapper is provided.
 *
 * @example
 *   const rows = await runQuery(dialect, executor, handle, mapper, columns, selectAst)
 *
 * @param query - Resolved query compilation and relation-member lookup operations.
 * @param executor - Database executor.
 * @param handle - Table handle for result mapping.
 * @param mapper - Optional value mapper for result conversion.
 * @param resultColumns - Output-to-source mappings for selected columns.
 * @param ast - Query AST node to execute.
 *
 * @returns Query result rows
 */
async function runQuery<T>(
  query: DialectQueryResolution,
  executor: Executor,
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  resultColumns: ReadonlyMap<string, ResultColumn>,
  ast: SelectAst | InsertAst | UpdateAst | DeleteAst,
): Promise<T> {
  const compiled = query.compile(ast)
  const rows = restoreResultNames(
    compiled,
    await executeQueryOperation(ast, () => executor.execute(compiled)),
  )

  if (mapper && ast.kind === 'select') {
    return mapSelectedRows(mapper, rows, resultColumns) as T
  }

  if (mapper && 'returning' in ast && ast.returning) {
    return mapper.mapResultRows(handle, rows) as T
  }

  return rows as T
}

/**
 * Compiles and executes a write AST (INSERT/UPDATE/DELETE), returning rows or a write
 * result.
 *
 * @example
 *   const result = await runWrite(dialect, executor, handle, mapper, insertAst)
 *
 * @param query - Resolved query compilation and relation-member lookup operations.
 * @param executor - Database executor.
 * @param handle - Table handle for result mapping.
 * @param mapper - Optional value mapper for result conversion.
 * @param ast - Write AST node to execute.
 *
 * @returns Mapped rows when RETURNING is used, or `WriteResult` with row count
 */
async function runWrite(
  query: DialectQueryResolution,
  executor: Executor,
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  ast: InsertAst | UpdateAst | DeleteAst,
): Promise<unknown[] | WriteResult> {
  const compiled = query.compile(ast)

  if (ast.returning) {
    const rows = restoreResultNames(
      compiled,
      await executeQueryOperation(ast, () => executor.execute(compiled)),
    )

    return mapper ? mapper.mapResultRows(handle, rows) : rows
  }

  const rowCount = await executeQueryOperation(ast, () => executor.run(compiled))

  if (rowCount === undefined || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new InvariantError(
      'Write execution requires a nonnegative safe integer affected-row count',
    )
  }

  return { rowCount }
}

/** Adds query operation context to recognized execution failures and retains diagnostics. */
async function executeQueryOperation<T>(
  ast: SelectAst | InsertAst | UpdateAst | DeleteAst,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    const action =
      ast.kind === 'select'
        ? 'select from'
        : ast.kind === 'insert'
          ? ast.conflict
            ? 'upsert into'
            : 'insert into'
          : ast.kind === 'update'
            ? 'update'
            : 'delete from'

    const message = `Failed to ${action} ${formatRelationInput(ast.relation)}`

    throw contextualOperationError(cause, message)
  }
}

/**
 * Returns the first row from an array, or throws when empty.
 *
 * @example
 *   const row = takeFirstOrThrow(rows, 'No rows returned from insert')
 *
 * @param rows - Array of result rows.
 * @param message - Error message when the array is empty.
 *
 * @returns The first row
 *
 * @throws QueryError - When the array is empty
 */
function takeFirstOrThrow<T>(rows: T[], message: string): T {
  const row = rows[0]

  if (row === undefined) {
    throw new QueryError({ message })
  }

  return row
}

// ---------------------------------------------------------------------------
// Insert builder
// ---------------------------------------------------------------------------

export type InsertBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = NoReturning,
> = {
  /** Selects an authored candidate key to handle insert conflicts. */
  onConflict(
    columns: readonly TableColumnInput<THandle>[],
  ): InsertConflictBuilder<THandle, TResult>
  /**
   * Creates a write builder that returns every affected row's columns.
   *
   * @returns A fresh write builder configured to return all columns of affected rows.
   */
  returningAll(): InsertBuilder<THandle, InferSelect<THandle>>
  /** Returns a fresh builder that reports the affected-row count without result rows. */
  returningNone(): InsertBuilder<THandle>
  /**
   * Creates a write builder that returns the requested columns.
   *
   * @param columns - Ordered column names, references, or observations used by this
   *   operation.
   *
   * @returns A fresh write builder configured to return the requested columns.
   */
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): InsertBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  /**
   * Compiles the current query or command into SQL and ordered bound parameters.
   *
   * @returns Compiled SQL and bound values in emitted order.
   */
  compile(): CompiledQuery
  /**
   * Executes the compiled query through its owning session or executor.
   *
   * @returns Query result rows, or the native write result for a statement without
   *   returned rows.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  execute(): Promise<TResult extends NoReturning ? WriteResult : TResult[]>
  /**
   * Executes the query and returns its first row, or undefined when no row exists.
   *
   * @returns The first result row, or undefined when no row exists.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirst(): Promise<
    TResult extends NoReturning ? WriteResult : TResult | undefined
  >
  /**
   * Executes the query and requires a result row, preserving write results without a
   * returning clause.
   *
   * @returns The first result row, or the write result when no returning clause is
   *   configured.
   *
   * @throws {QueryError} Invalid query use, a closed client, or a missing required row.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirstOrThrow(): Promise<TResult extends NoReturning ? WriteResult : TResult>
}

type TableColumnName<THandle extends TableHandle> = keyof InferSelect<THandle> & string

type TableColumnRef<THandle extends TableHandle> = Extract<
  THandle[TableColumnName<THandle> & keyof THandle],
  ColumnRef
>

type TableColumnInput<THandle extends TableHandle> =
  | TableColumnName<THandle>
  | TableColumnRef<THandle>

type InsertableColumnRef<THandle extends TableHandle> = Extract<
  THandle[keyof InferInsert<THandle> & keyof THandle],
  ColumnRef
>

type CompatibleExcludedRef<TColumn, TValue> =
  TColumn extends ColumnRef<string, string, infer TColumnValue>
    ? Exclude<TColumnValue, undefined> extends Exclude<TValue, undefined>
      ? ExcludedRef<TColumn>
      : never
    : never

type ConflictUpdatePatch<THandle extends TableHandle> = {
  [K in keyof InferUpdate<THandle>]?:
    | InferUpdate<THandle>[K]
    | CompatibleExcludedRef<InsertableColumnRef<THandle>, InferUpdate<THandle>[K]>
}

/** Action-only state entered after selecting an insert conflict target. */
export type InsertConflictBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = NoReturning,
> = {
  /** Ignores a row that conflicts with the selected candidate key. */
  doNothing(): InsertBuilder<THandle, TResult>
  /** Updates writable columns when a row conflicts with the selected candidate key. */
  doUpdate(patch: ConflictUpdatePatch<THandle>): InsertBuilder<THandle, TResult>
}

/**
 * Creates an insert builder for inserting rows into a table.
 *
 * @example
 *   const builder = createInsertBuilder({
 *     handle: User,
 *     dialect,
 *     executor,
 *     rows: [{ name: 'Alice' }],
 *     returning: { kind: 'all' },
 *   })
 *   const result = await builder.execute()
 *
 * @param options - Builder configuration including handle, dialect, executor, rows, and
 *   returning.
 *
 * @returns Insert builder with `returning`, `compile`, and `execute` methods
 */
export function createInsertBuilder<THandle extends TableHandle>(
  options: InsertBuilderOptions<THandle>,
): InsertBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, rows, returning, conflict } = options
  const captured = { handle, dialect, executor, mapper, rows, returning, conflict }

  const query = options.query ?? dialect.query.resolve([handle])

  const buildAst = () =>
    buildInsertAst({ handle, dialect, executor, mapper, rows, returning, conflict })

  /** Compiles the current insert query. */
  const compile = () => markCompiledQuery(query.compile(buildAst()))

  /** Executes the current insert query. */
  const execute = async () => runWrite(query, executor, handle, mapper, buildAst())
  const { executeTakeFirst, executeTakeFirstOrThrow } = writeResultTerminals(
    execute,
    returning,
    'insert',
  )

  return {
    onConflict(columns) {
      const target = resolveConflictTarget(handle, columns)
      return {
        doNothing: () =>
          createInsertBuilder({
            ...captured,
            query,
            conflict: { target, action: { kind: 'doNothing' } },
          }) as never,
        doUpdate: (patch) =>
          createInsertBuilder({
            ...captured,
            query,
            conflict: {
              target,
              action: {
                kind: 'doUpdate',
                set: resolveConflictUpdate(handle, patch),
              },
            },
          }) as never,
      }
    },
    ...createWriteReturning((changes) =>
      createInsertBuilder({ ...captured, query, ...changes }),
    ),
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Insert-values builder (db.insert(table).values(row))
// ---------------------------------------------------------------------------

export type InsertValuesBuilder<THandle extends TableHandle = TableHandle> = {
  /**
   * Supplies insert rows for schema validation and SQL compilation.
   *
   * @param row - Current native catalog row, insert row, or result object.
   *
   * @returns An insert builder containing the validated and mapped rows.
   *
   * @throws {ValidationError} Invalid row values are rejected synchronously.
   */
  values(
    row: InferInsert<THandle> | InferInsert<THandle>[],
  ): InsertBuilder<THandle, InferSelect<THandle>>
}

/** Resolves and validates one candidate-key conflict target. */
function resolveConflictTarget<THandle extends TableHandle>(
  handle: THandle,
  columns: readonly TableColumnInput<THandle>[],
): string[] {
  const tableName = handle.getTableMetadata().name

  if (columns.length === 0) {
    throw new QueryError({
      message: `onConflict(...) on "${tableName}" requires at least one column`,
    })
  }

  const entries = handle.getSchema().entries as Record<string, unknown>
  const target = columns.map((column) =>
    resolveConflictColumn(handle, entries, tableName, column),
  )

  if (new Set(target).size !== target.length) {
    throw new QueryError({
      message: `onConflict(...) on "${tableName}" contains duplicate columns`,
    })
  }

  const metadata = handle.getTableMetadata()
  const primaryKey = Array.isArray(metadata.primaryKey)
    ? metadata.primaryKey
    : [metadata.primaryKey]

  const uniqueTargets = [
    primaryKey,
    ...(metadata.indexes ?? [])
      .filter((index) => index.unique === true)
      .map((index) => index.columns),
    ...Object.entries(handle.getSchema().entries)
      .filter(([, schema]) => getColumnMetadata(schema)?.unique === true)
      .map(([name]) => [name]),
  ]

  const matchesCandidateKey = uniqueTargets.some(
    (candidate) =>
      candidate.length === target.length &&
      candidate.every((name, index) => name === target[index]),
  )

  if (!matchesCandidateKey) {
    throw new QueryError({
      message: `onConflict(...) on "${tableName}" must exactly match an authored candidate key in column order`,
    })
  }

  return target
}

/** Resolves one conflict target column and rejects foreign references. */
function resolveConflictColumn<THandle extends TableHandle>(
  handle: THandle,
  entries: Record<string, unknown>,
  tableName: string,
  column: TableColumnInput<THandle>,
): string {
  const name = columnName(column)

  if (!Object.hasOwn(entries, name)) {
    throw new QueryError({
      message: `onConflict(...) on "${tableName}" references unknown column "${name}"`,
    })
  }

  if (typeof column !== 'string' && handle[name as keyof THandle] !== column) {
    throw new QueryError({
      message: `onConflict(...) on "${tableName}" references a foreign column "${name}"`,
    })
  }

  return name
}

/** Validates and structures a conflict update patch in authored property order. */
function resolveConflictUpdate<THandle extends TableHandle>(
  handle: THandle,
  patch: ConflictUpdatePatch<THandle>,
): Extract<InsertConflictAst['action'], { kind: 'doUpdate' }>['set'] {
  const cleaned = validateUpdatePatchWithStructuredValues(handle, patch, isExcludedRef)
  const insertable = new Set(Object.keys(buildInsertSchema(handle).entries))

  return Object.entries(cleaned).map(([column, value]) => {
    if (!isExcludedRef(value)) {
      return { column, value: { kind: 'value' as const, value } }
    }

    const source = value.column.column
    const ownedReference =
      Object.hasOwn(handle.getSchema().entries, source) &&
      handle[source as keyof THandle] === value.column

    if (!ownedReference || !insertable.has(source)) {
      throw new QueryError({
        message: `excluded(...) on "${handle.getTableMetadata().name}" requires an insertable column from the same table handle`,
      })
    }

    return { column, value: { kind: 'excluded' as const, column: source } }
  })
}

/** Maps only bound values in a structured conflict action. */
function mapConflictParams(
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  conflict: InsertConflictAst,
): InsertConflictAst {
  if (!mapper || conflict.action.kind === 'doNothing') return conflict

  return {
    ...conflict,
    action: {
      kind: 'doUpdate',
      set: conflict.action.set.map((assignment) =>
        assignment.value.kind === 'value'
          ? {
              ...assignment,
              value: {
                kind: 'value',
                value: mapper.mapParam(handle, assignment.column, assignment.value.value),
              },
            }
          : assignment,
      ),
    },
  }
}

// ---------------------------------------------------------------------------
// Update builder
// ---------------------------------------------------------------------------

export type UpdateSetBuilder<THandle extends TableHandle = TableHandle> = {
  /**
   * Supplies the column patch for schema validation and update compilation.
   *
   * @param patch - Column updates or builder state changes applied to a fresh builder.
   *
   * @returns An update builder containing the validated and mapped column patch.
   *
   * @throws {ValidationError} Invalid literal values are rejected synchronously; deferred
   *   expressions are checked before SQL execution.
   */
  set(patch: UpdatePatch<THandle>): UpdateBuilder<THandle, InferSelect<THandle>>
}

export type UpdateBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = NoReturning,
> = {
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param column - Authored or observed column metadata used for storage comparison.
   * @param op - SQL operator used by the fixture expression.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): UpdateBuilder<THandle, TResult>
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param predicate - Predicate or predicate factory used to filter query results.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): UpdateBuilder<THandle, TResult>
  /** Opt into full-table update (no where). */
  all(): UpdateBuilder<THandle, TResult>
  /**
   * Creates a write builder that returns every affected row's columns.
   *
   * @returns A fresh write builder configured to return all columns of affected rows.
   */
  returningAll(): UpdateBuilder<THandle, InferSelect<THandle>>
  /** Returns a fresh builder that reports the affected-row count without result rows. */
  returningNone(): UpdateBuilder<THandle>
  /**
   * Creates a write builder that returns the requested columns.
   *
   * @param columns - Ordered column names, references, or observations used by this
   *   operation.
   *
   * @returns A fresh write builder configured to return the requested columns.
   */
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): UpdateBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  /**
   * Compiles the current query or command into SQL and ordered bound parameters.
   *
   * @returns Compiled SQL and bound values in emitted order.
   */
  compile(): CompiledQuery
  /**
   * Executes the compiled query through its owning session or executor.
   *
   * @returns Query result rows, or the native write result for a statement without
   *   returned rows.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   * @throws {ValidationError} A deferred update expression produces an invalid value.
   */
  execute(): Promise<TResult extends NoReturning ? WriteResult : Prettify<TResult>[]>
  /**
   * Executes the query and returns its first row, or undefined when no row exists.
   *
   * @returns The first result row, or undefined when no row exists.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   * @throws {ValidationError} A deferred update expression produces an invalid value.
   */
  executeTakeFirst(): Promise<
    TResult extends NoReturning ? WriteResult : TResult | undefined
  >
  /**
   * Executes the query and requires a result row, preserving write results without a
   * returning clause.
   *
   * @returns The first result row, or the write result when no returning clause is
   *   configured.
   *
   * @throws {QueryError} Invalid query use, a closed client, or a missing required row.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   * @throws {ValidationError} A deferred update expression produces an invalid value.
   */
  executeTakeFirstOrThrow(): Promise<TResult extends NoReturning ? WriteResult : TResult>
}

/**
 * Creates an update builder for modifying rows in a table.
 *
 * @example
 *   const builder = createUpdateBuilder({
 *     handle: User,
 *     dialect,
 *     executor,
 *     patch: { name: 'Bob' },
 *     where: cmp('id', 'eq', 1),
 *     allowAll: false,
 *     returning: { kind: 'all' },
 *   })
 *   const result = await builder.execute()
 *
 * @param options - Builder configuration including handle, dialect, executor, patch,
 *   where, and returning.
 *
 * @returns Update builder with `where`, `all`, `returning`, `compile`, and `execute`
 *   methods.
 */
export function createUpdateBuilder<THandle extends TableHandle>(
  options: UpdateBuilderOptions<THandle>,
): UpdateBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, patch, where, allowAll, returning } = options
  const query = options.query ?? dialect.query.resolve([handle])
  const captured = {
    handle,
    dialect,
    query,
    executor,
    mapper,
    patch,
    where,
    allowAll,
    returning,
  }

  /** Builds the update AST. */
  const buildAst = () =>
    buildUpdateAst(
      { handle, dialect, executor, mapper, patch, where, allowAll, returning },
      query,
    )

  /** Compiles the current update query. */
  const compile = () => markCompiledQuery(query.compile(buildAst()))

  /** Executes the current update query. */
  const execute = async () => runWrite(query, executor, handle, mapper, buildAst())
  const { executeTakeFirst, executeTakeFirstOrThrow } = writeResultTerminals(
    execute,
    returning,
    'update',
  )

  /** Creates a new builder with patched query state while preserving unchanged clauses. */
  const next = (changes: Partial<Parameters<typeof createUpdateBuilder<THandle>>[0]>) =>
    createUpdateBuilder({ ...captured, ...changes })

  return {
    ...createWriteFilters(where, next),
    ...createWriteReturning(next),
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Delete builder
// ---------------------------------------------------------------------------

export type DeleteBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = NoReturning,
> = {
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param column - Authored or observed column metadata used for storage comparison.
   * @param op - SQL operator used by the fixture expression.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): DeleteBuilder<THandle, TResult>
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param predicate - Predicate or predicate factory used to filter query results.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): DeleteBuilder<THandle, TResult>
  /** Opt into full-table delete (no where). */
  all(): DeleteBuilder<THandle, TResult>
  /**
   * Creates a write builder that returns every affected row's columns.
   *
   * @returns A fresh write builder configured to return all columns of affected rows.
   */
  returningAll(): DeleteBuilder<THandle, InferSelect<THandle>>
  /** Returns a fresh builder that reports the affected-row count without result rows. */
  returningNone(): DeleteBuilder<THandle>
  /**
   * Creates a write builder that returns the requested columns.
   *
   * @param columns - Ordered column names, references, or observations used by this
   *   operation.
   *
   * @returns A fresh write builder configured to return the requested columns.
   */
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): DeleteBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  /**
   * Compiles the current query or command into SQL and ordered bound parameters.
   *
   * @returns Compiled SQL and bound values in emitted order.
   */
  compile(): CompiledQuery
  /**
   * Executes the compiled query through its owning session or executor.
   *
   * @returns Query result rows, or the native write result for a statement without
   *   returned rows.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  execute(): Promise<TResult extends NoReturning ? WriteResult : TResult[]>
  /**
   * Executes the query and returns its first row, or undefined when no row exists.
   *
   * @returns The first result row, or undefined when no row exists.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirst(): Promise<
    TResult extends NoReturning ? WriteResult : TResult | undefined
  >
  /**
   * Executes the query and requires a result row, preserving write results without a
   * returning clause.
   *
   * @returns The first result row, or the write result when no returning clause is
   *   configured.
   *
   * @throws {QueryError} Invalid query use, a closed client, or a missing required row.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirstOrThrow(): Promise<TResult extends NoReturning ? WriteResult : TResult>
}

/**
 * Creates a delete builder for removing rows from a table.
 *
 * @example
 *   const builder = createDeleteBuilder({
 *     handle: User,
 *     dialect,
 *     executor,
 *     where: cmp('id', 'eq', 1),
 *     allowAll: false,
 *     returning: { kind: 'all' },
 *   })
 *   const deleted = await builder.execute()
 *
 * @param options - Builder configuration including handle, dialect, executor, where, and
 *   returning.
 *
 * @returns Delete builder with `where`, `all`, `returning`, `compile`, and `execute`
 *   methods.
 */
export function createDeleteBuilder<THandle extends TableHandle>(
  options: DeleteBuilderOptions<THandle>,
): DeleteBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, where, allowAll, returning } = options
  const query = options.query ?? dialect.query.resolve([handle])
  const captured = {
    handle,
    dialect,
    query,
    executor,
    mapper,
    where,
    allowAll,
    returning,
  }

  /** Builds the delete AST. */
  const buildAst = () =>
    buildDeleteAst(
      { handle, dialect, executor, mapper, where, allowAll, returning },
      query,
    )

  /** Compiles the current delete query. */
  const compile = () => markCompiledQuery(query.compile(buildAst()))

  /** Executes the current delete query. */
  const execute = async () => runWrite(query, executor, handle, mapper, buildAst())
  const { executeTakeFirst, executeTakeFirstOrThrow } = writeResultTerminals(
    execute,
    returning,
    'delete',
  )

  /** Creates a new builder with patched query state while preserving unchanged clauses. */
  const next = (changes: Partial<Parameters<typeof createDeleteBuilder<THandle>>[0]>) =>
    createDeleteBuilder({ ...captured, ...changes })

  return {
    ...createWriteFilters(where, next),
    ...createWriteReturning(next),
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Select builder
// ---------------------------------------------------------------------------

export type SelectBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = InferSelect<THandle>,
  HasSelection extends boolean = false,
  /** Schema-and-table identities whose selected columns are outer-join nullable. */
  TNullable = never,
  TProjection extends readonly unknown[] = HasSelection extends true
    ? []
    : WildcardProjection<InferSelect<THandle>>,
> = {
  readonly [projectionShape]?: TProjection
  /**
   * Selects every column from the root or requested joined table.
   *
   * @returns A fresh select builder including all columns of the selected table.
   */
  selectAll(): SelectBuilder<
    THandle,
    MergeSelection<HasSelection, TResult, InferSelectAllSide<THandle, TNullable>>,
    true,
    TNullable,
    HasSelection extends true
      ? [...TProjection, ...WildcardProjection<InferSelect<THandle>>]
      : TProjection
  >
  /**
   * Selects every column from the root or requested joined table.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   *
   * @returns A fresh select builder including all columns of the selected table.
   */
  selectAll<TSide extends TableHandle>(
    handle: TSide,
  ): SelectBuilder<
    THandle,
    MergeSelection<HasSelection, TResult, InferSelectAllSide<TSide, TNullable>>,
    true,
    TNullable,
    HasSelection extends true
      ? [...TProjection, ...WildcardProjection<InferSelect<TSide>>]
      : WildcardProjection<InferSelect<TSide>>
  >
  /**
   * Adds selected columns or expressions to the query's result shape.
   *
   * @param columns - Ordered column names, references, or observations used by this
   *   operation.
   *
   * @returns A fresh select builder with the requested columns or expressions added.
   */
  select<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): SelectBuilder<
    THandle,
    MergeSelection<
      HasSelection,
      TResult,
      InferSelectedColumns<THandle, TCols, TNullable>
    >,
    true,
    TNullable,
    HasSelection extends true ? [...TProjection, ...TCols] : TCols
  >
  /**
   * Adds selected columns or expressions to the query's result shape.
   *
   * @param callback - Work to run within the owned client or session scope.
   *
   * @returns A fresh select builder with the requested columns or expressions added.
   */
  select<const TItems extends readonly SelectionItem[]>(
    callback: (builder: ExpressionBuilder) => TItems,
  ): SelectBuilder<
    THandle,
    MergeSelection<
      HasSelection,
      TResult,
      InferCallbackSelection<THandle, TItems, TNullable>
    >,
    true,
    TNullable,
    HasSelection extends true ? [...TProjection, ...TItems] : TItems
  >
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param column - Authored or observed column metadata used for storage comparison.
   * @param op - SQL operator used by the fixture expression.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param predicate - Predicate or predicate factory used to filter query results.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Adds an exclusive cursor boundary after the supplied values, combined with existing
   * filters.
   *
   * @param order - Sort terms matching ORDER BY, including a unique tie-breaker.
   * @param values - Application cursor values in sort-term order.
   */
  after(
    order: readonly OrderTerm[],
    values: readonly unknown[],
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Adds an exclusive cursor boundary before the supplied values, combined with existing
   * filters.
   *
   * @param order - Sort terms matching ORDER BY, including a unique tie-breaker.
   * @param values - Application cursor values in sort-term order.
   */
  before(
    order: readonly OrderTerm[],
    values: readonly unknown[],
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Adds an ordering clause with an ascending or descending direction.
   *
   * @param column - Column reference or authored name used to address the query member.
   * @param direction - Ascending or descending sort direction.
   * @param nulls - Explicit null placement, or the dialect default when omitted.
   *
   * @returns A fresh select builder with the requested sort clause appended.
   */
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
    nulls?: 'first' | 'last',
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Sets the maximum number of result rows.
   *
   * @param count - Row limit or offset count for the requested query operation.
   *
   * @returns A fresh select builder with the requested row limit.
   */
  limit(
    count: number,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Sets the number of result rows to skip.
   *
   * @param count - Number of result rows to skip before returning rows.
   *
   * @returns A fresh select builder with the requested row offset.
   */
  offset(
    count: number,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Adds columns to the query's grouping clause.
   *
   * @param columns - Ordered column names, references, or observations used by this
   *   operation.
   *
   * @returns A fresh select builder with the requested grouping columns.
   */
  groupBy(
    columns: readonly (ColumnRef | string)[] | ColumnRef | string,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Adds a predicate evaluated against grouped query results.
   *
   * @param predicate - Predicate or predicate factory used to filter query results.
   *
   * @returns A fresh select builder with the requested grouped-result predicate.
   */
  having(
    predicate: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable, TProjection>
  /**
   * Adds an inner join and its ON predicate to the current query.
   *
   * @param table - Table metadata or evidence used to resolve its members.
   * @param on - Join predicate or factory that produces the ON expression.
   *
   * @returns A fresh select builder with the inner join and its relation handle
   *   registered.
   */
  innerJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    MergeJoinStar<HasSelection, TResult, InferSelect<TSide>>,
    HasSelection,
    TNullable,
    HasSelection extends true ? TProjection : readonly [unknown, unknown]
  >
  /**
   * Adds a left join and its ON predicate to the current query.
   *
   * @param table - Table metadata or evidence used to resolve its members.
   * @param on - Join predicate or factory that produces the ON expression.
   *
   * @returns A fresh select builder with the left join and its relation handle
   *   registered.
   */
  leftJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    MergeJoinStar<HasSelection, TResult, NullableFields<InferSelect<TSide>>>,
    HasSelection,
    TNullable | TableIdentityOf<TSide>,
    HasSelection extends true ? TProjection : readonly [unknown, unknown]
  >
  /**
   * Adds a right join and its ON predicate to the current query.
   *
   * @param table - Table metadata or evidence used to resolve its members.
   * @param on - Join predicate or factory that produces the ON expression.
   *
   * @returns A fresh select builder with the right join and its relation handle
   *   registered.
   */
  rightJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    HasSelection extends true ? TResult : RightJoinStarResult<THandle, TResult, TSide>,
    HasSelection,
    TNullable | TableIdentityOf<THandle>,
    HasSelection extends true ? TProjection : readonly [unknown, unknown]
  >
  /**
   * Compiles the current query or command into SQL and ordered bound parameters.
   *
   * @returns Compiled SQL and bound values in emitted order.
   */
  compile(): CompiledQuery
  /**
   * Executes the compiled query through its owning session or executor.
   *
   * @returns Query result rows, or the native write result for a statement without
   *   returned rows.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  execute(): Promise<Prettify<TResult>[]>
  /**
   * Executes the query and returns its first row, or undefined when no row exists.
   *
   * @returns The first result row, or undefined when no row exists.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirst(): Promise<TResult | undefined>
  /**
   * Executes the query and requires a result row, preserving write results without a
   * returning clause.
   *
   * @returns The first result row, or the write result when no returning clause is
   *   configured.
   *
   * @throws {QueryError} Invalid query use, a closed client, or a missing required row.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirstOrThrow(): Promise<TResult>
}

type SelectState = {
  selection: SelectItemAst[]
  joins: JoinAst[]
  joinedHandles: TableHandle[]
  where?: PredicateAst
  orderBy: OrderByAst[]
  limit?: number
  offset?: number
  groupBy: QualifiedColumnAst[]
  having?: PredicateAst
}

/** Builds the select AST and result-column mappings. */
function buildSelectQuery(
  options: {
    handle: TableHandle
    query: DialectQueryResolution
    mapper?: ValueMapper
    state: SelectState
  },
  mapResults = true,
) {
  const { handle, query, state } = options
  const info = handle.getTableMetadata()
  recordQueryRelation(info.relation, handle)
  const handles = [handle, ...state.joinedHandles]
  const selection =
    state.selection.length === 0 ? [{ kind: 'all' } as const] : state.selection

  const resultColumns = mapResults
    ? resultColumnsForSelection(query, handles, selection)
    : new Map<string, ResultColumn>()

  const ast: SelectAst = {
    kind: 'select',
    relation: info.relation,
    selection,
    ...(state.joins.length > 0 ? { joins: state.joins } : {}),
    ...(state.where ? { where: state.where } : {}),
    ...(state.orderBy.length > 0 ? { orderBy: state.orderBy } : {}),
    ...(state.limit !== undefined ? { limit: state.limit } : {}),
    ...(state.offset !== undefined ? { offset: state.offset } : {}),
    ...(state.groupBy.length > 0 ? { groupBy: state.groupBy } : {}),
    ...(state.having ? { having: state.having } : {}),
  }

  authoredSelects.set(ast, { handles, query, mapper: options.mapper })
  return { ast, resultColumns }
}

/** Applies select state changes while preserving explicit clearing of optional clauses. */
function patchSelectState(state: SelectState, patch: Partial<SelectState>): SelectState {
  return {
    selection: patch.selection ?? state.selection,
    joins: patch.joins ?? state.joins,
    joinedHandles: patch.joinedHandles ?? state.joinedHandles,
    where: 'where' in patch ? patch.where : state.where,
    orderBy: patch.orderBy ?? state.orderBy,
    limit: 'limit' in patch ? patch.limit : state.limit,
    offset: 'offset' in patch ? patch.offset : state.offset,
    groupBy: patch.groupBy ?? state.groupBy,
    having: 'having' in patch ? patch.having : state.having,
  }
}

/** Creates join clauses while retaining all previously joined handles. */
function createSelectJoins<THandle extends TableHandle>(
  state: SelectState,
  next: (patch: Partial<SelectState>) => SelectBuilder<THandle, unknown>,
): Pick<SelectBuilder<THandle, unknown>, 'innerJoin' | 'leftJoin' | 'rightJoin'> {
  return {
    /**
     * Appends an inner join.
     *
     * @param table - Table to join.
     * @param on - Join predicate input.
     */
    innerJoin(table, on) {
      return next({
        joins: [...state.joins, toJoinAst('inner', table, on)],
        joinedHandles: [...state.joinedHandles, table],
      }) as never
    },
    /**
     * Appends a left join.
     *
     * @param table - Table to join.
     * @param on - Join predicate input.
     */
    leftJoin(table, on) {
      return next({
        joins: [...state.joins, toJoinAst('left', table, on)],
        joinedHandles: [...state.joinedHandles, table],
      }) as never
    },
    /**
     * Appends a right join.
     *
     * @param table - Table to join.
     * @param on - Join predicate input.
     */
    rightJoin(table, on) {
      return next({
        joins: [...state.joins, toJoinAst('right', table, on)],
        joinedHandles: [...state.joinedHandles, table],
      }) as never
    },
  }
}

/** Creates ordering and pagination clauses for a select query. */
function createSelectPagination<THandle extends TableHandle>(
  state: SelectState,
  next: (patch: Partial<SelectState>) => SelectBuilder<THandle, unknown>,
): Pick<SelectBuilder<THandle, unknown>, 'orderBy' | 'limit' | 'offset'> {
  return {
    /**
     * Appends an ordering clause.
     *
     * @param column - Column to order by.
     * @param direction - Sort direction.
     */
    orderBy(column, direction: 'asc' | 'desc' = 'asc', nulls) {
      const q = toQualified(column)
      return next({
        orderBy: [
          ...state.orderBy,
          {
            column: q.column,
            ...(q.relation !== undefined ? { relation: q.relation } : {}),
            direction,
            ...(nulls === undefined ? {} : { nulls }),
          },
        ],
      }) as never
    },
    /**
     * Sets the row limit.
     *
     * @param count - Maximum rows to return.
     */
    limit(count) {
      return next({ limit: count }) as never
    },
    /**
     * Sets the row offset.
     *
     * @param count - Rows to skip.
     */
    offset(count) {
      return next({ offset: count }) as never
    },
  }
}

/**
 * Creates a select builder from an initial state.
 *
 * @example
 *   const builder = createSelectBuilder({ handle: User, dialect, executor, state: emptySelectState() })
 *
 * @param options - Builder configuration including handle, dialect, executor, mapper, and
 *   state.
 *
 * @returns Select builder with chaining methods and execution
 */
function createSelectBuilder<THandle extends TableHandle>(
  options: SelectBuilderOptions<THandle>,
): SelectBuilder<THandle, unknown> {
  const { handle, dialect, query, executor, mapper, state } = options

  /**
   * Returns a select builder with patched state.
   *
   * @param patch - State values to replace.
   */
  const next = (patch: Partial<SelectState>) =>
    createSelectBuilder({
      handle,
      dialect,
      query,
      executor,
      mapper,
      state: patchSelectState(state, patch),
    })

  /** Compiles the current select query. */
  const compile = () =>
    markCompiledQuery(
      query.compile(prepareStatement(buildSelectQuery(options).ast, options.executor)),
    )

  /** Executes the current select query. */
  const execute = () => executeSelect(options)

  /** Executes the select and returns its first row. */
  const executeTakeFirst = async () => {
    const rows = (await execute()) as unknown[]
    return rows[0]
  }

  /** Executes the query and requires its first result. */
  const executeTakeFirstOrThrow = () => takeFirstSelectRow(execute)

  const builder = {
    ...createSelectSelection(state, next),
    ...createSelectFilters(state, next),
    ...createSelectBoundaries(state, next),
    ...createSelectPagination(state, next),
    ...createSelectGrouping(state, next),
    ...createSelectJoins(state, next),
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }

  selectDefinitions.set(builder, {
    owner: executor,
    build: () => buildSelectQuery(options, false).ast,
  })

  return builder
}

// ---------------------------------------------------------------------------
// Root table query builder
// ---------------------------------------------------------------------------

/**
 * Fluent query builder rooted on a registered table handle.
 * Default terminal path is `select *`; use insert/update/delete for writes.
 */
export type QueryBuilder<THandle extends TableHandle = TableHandle> = {
  readonly [projectionShape]?: WildcardProjection<InferSelect<THandle>>

  /** Compile `select * from table` (default read path). */
  compile(): CompiledQuery
  /**
   * Execute `select * from table`.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  execute(): Promise<InferSelect<THandle>[]>
  /**
   * Executes the query and returns its first row, or undefined when no row exists.
   *
   * @returns The first result row, or undefined when no row exists.
   *
   * @throws {QueryError} Invalid query use or a closed client.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirst(): Promise<InferSelect<THandle> | undefined>
  /**
   * Executes the query and requires a result row, preserving write results without a
   * returning clause.
   *
   * @returns The first result row, or the write result when no returning clause is
   *   configured.
   *
   * @throws {QueryError} Invalid query use, a closed client, or a missing required row.
   * @throws {DriverError} The database, driver, or db0 rejects SQL execution.
   */
  executeTakeFirstOrThrow(): Promise<InferSelect<THandle>>
  /** Explicit select-all (same as default execute path). */
  selectAll(): SelectBuilder<
    THandle,
    InferSelect<THandle>,
    true,
    never,
    WildcardProjection<InferSelect<THandle>>
  >
  /**
   * Selects every column from the root or requested joined table.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   *
   * @returns A fresh select builder including all columns of the selected table.
   */
  selectAll<TSide extends TableHandle>(
    handle: TSide,
  ): SelectBuilder<
    THandle,
    InferSelect<TSide>,
    true,
    never,
    WildcardProjection<InferSelect<TSide>>
  >
  /**
   * Adds selected columns or expressions to the query's result shape.
   *
   * @param columns - Ordered column names, references, or observations used by this
   *   operation.
   *
   * @returns A fresh select builder with the requested columns or expressions added.
   */
  select<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): SelectBuilder<THandle, InferSelectedColumns<THandle, TCols>, true, never, TCols>
  /**
   * Adds selected columns or expressions to the query's result shape.
   *
   * @param callback - Work to run within the owned client or session scope.
   *
   * @returns A fresh select builder with the requested columns or expressions added.
   */
  select<const TItems extends readonly SelectionItem[]>(
    callback: (builder: ExpressionBuilder) => TItems,
  ): SelectBuilder<
    THandle,
    InferCallbackSelection<THandle, TItems, never>,
    true,
    never,
    TItems
  >
  /**
   * Adds an inner join and its ON predicate to the current query.
   *
   * @param table - Table metadata or evidence used to resolve its members.
   * @param on - Join predicate or factory that produces the ON expression.
   *
   * @returns A fresh select builder with the inner join and its relation handle
   *   registered.
   */
  innerJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    InferSelect<THandle> & InferSelect<TSide>,
    false,
    never,
    readonly [unknown, unknown]
  >
  /**
   * Adds a left join and its ON predicate to the current query.
   *
   * @param table - Table metadata or evidence used to resolve its members.
   * @param on - Join predicate or factory that produces the ON expression.
   *
   * @returns A fresh select builder with the left join and its relation handle
   *   registered.
   */
  leftJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    InferSelect<THandle> & NullableFields<InferSelect<TSide>>,
    false,
    TableIdentityOf<TSide>,
    readonly [unknown, unknown]
  >
  /**
   * Adds a right join and its ON predicate to the current query.
   *
   * @param table - Table metadata or evidence used to resolve its members.
   * @param on - Join predicate or factory that produces the ON expression.
   *
   * @returns A fresh select builder with the right join and its relation handle
   *   registered.
   */
  rightJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    NullableFields<InferSelect<THandle>> & InferSelect<TSide>,
    false,
    TableIdentityOf<THandle>,
    readonly [unknown, unknown]
  >
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param column - Authored or observed column metadata used for storage comparison.
   * @param op - SQL operator used by the fixture expression.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Adds a filter and combines it with any existing predicate using AND.
   *
   * @param predicate - Predicate or predicate factory used to filter query results.
   *
   * @returns A fresh builder with the new predicate combined with any existing filter
   *   using AND.
   */
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Adds an exclusive cursor boundary after the supplied values, combined with existing
   * filters.
   *
   * @param order - Sort terms matching ORDER BY, including a unique tie-breaker.
   * @param values - Application cursor values in sort-term order.
   */
  after(
    order: readonly OrderTerm[],
    values: readonly unknown[],
  ): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Adds an exclusive cursor boundary before the supplied values, combined with existing
   * filters.
   *
   * @param order - Sort terms matching ORDER BY, including a unique tie-breaker.
   * @param values - Application cursor values in sort-term order.
   */
  before(
    order: readonly OrderTerm[],
    values: readonly unknown[],
  ): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Adds an ordering clause with an ascending or descending direction.
   *
   * @param column - Column reference or authored name used to address the query member.
   * @param direction - Ascending or descending sort direction.
   * @param nulls - Explicit null placement, or the dialect default when omitted.
   *
   * @returns A fresh select builder with the requested sort clause appended.
   */
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
    nulls?: 'first' | 'last',
  ): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Sets the maximum number of result rows.
   *
   * @param count - Row limit or offset count for the requested query operation.
   *
   * @returns A fresh select builder with the requested row limit.
   */
  limit(count: number): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Sets the number of result rows to skip.
   *
   * @param count - Number of result rows to skip before returning rows.
   *
   * @returns A fresh select builder with the requested row offset.
   */
  offset(count: number): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Adds columns to the query's grouping clause.
   *
   * @param columns - Ordered column names, references, or observations used by this
   *   operation.
   *
   * @returns A fresh select builder with the requested grouping columns.
   */
  groupBy(
    columns: readonly (ColumnRef | string)[] | ColumnRef | string,
  ): SelectBuilder<THandle, InferSelect<THandle>>
  /**
   * Adds a predicate evaluated against grouped query results.
   *
   * @param predicate - Predicate or predicate factory used to filter query results.
   *
   * @returns A fresh select builder with the requested grouped-result predicate.
   */
  having(
    predicate: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, InferSelect<THandle>>
}

/** Creates an empty select-builder state. */
function emptySelectState(): SelectState {
  return {
    selection: [],
    joins: [],
    joinedHandles: [],
    orderBy: [],
    groupBy: [],
  }
}

/**
 * Creates a table-scoped query builder (select + insert/update/delete).
 *
 * @example
 *   const builder = createTableBuilder({ handle: User, dialect, executor, mapper })
 *   const users = await builder.execute()
 *
 * @param options - Builder configuration including handle, dialect, executor, and
 *   optional mapper.
 *
 * @returns Query builder with `selectAll`, `select`, `where`, `compile`, and `execute`
 *   methods.
 */
export function createTableBuilder<THandle extends TableHandle>(
  options: TableBuilderOptions<THandle>,
): QueryBuilder<THandle> {
  const { handle, dialect, executor, mapper } = options
  const query = options.query ?? dialect.query.resolve([handle])

  /** Creates a select builder rooted at the table. */
  const rootSelect = () =>
    createSelectBuilder({
      handle,
      dialect,
      query,
      executor,
      mapper,
      state: emptySelectState(),
    })

  // Default path: select * with no filters (terminals on QueryBuilder)
  const defaultSelect = createSelectBuilder({
    handle,
    dialect,
    query,
    executor,
    mapper,
    state: emptySelectState(),
  })

  const builder = {
    /** Compiles the default select query. */
    compile: () => defaultSelect.compile(),
    /** Executes the default select query. */
    execute: () => defaultSelect.execute() as Promise<InferSelect<THandle>[]>,
    /** Executes the default select and returns its first row. */
    executeTakeFirst: () =>
      defaultSelect.executeTakeFirst() as Promise<InferSelect<THandle> | undefined>,
    /** Executes the default select and requires a row. */
    executeTakeFirstOrThrow: () =>
      defaultSelect.executeTakeFirstOrThrow() as Promise<InferSelect<THandle>>,
    ...createTableSelection(rootSelect),
    ...createTableJoins(rootSelect),
    ...createTablePagination(rootSelect),
  }

  selectDefinitions.set(builder, selectDefinitions.get(defaultSelect)!)
  return builder
}

type InsertBuilderOptions<THandle extends TableHandle> = {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  rows: Record<string, unknown>[]
  conflict?: InsertConflictAst
  returning?: ReturningAst
}

/**
 * Builds an insert AST with ordered columns and mapped row values.
 *
 * @param options - Configuration and dependencies for this operation.
 *
 * @returns An insert AST with ordered columns and mapped row values.
 */
function buildInsertAst<THandle extends TableHandle>(
  options: InsertBuilderOptions<THandle>,
): InsertAst {
  const { handle, mapper, rows, conflict, returning } = options
  const columnSet: string[] = []
  const seen = new Set<string>()
  for (const key of rows.flatMap((row) => Object.keys(row))) {
    if (!seen.has(key)) {
      seen.add(key)
      columnSet.push(key)
    }
  }

  const info = handle.getTableMetadata()
  recordQueryRelation(info.relation, handle)

  if (columnSet.length === 0) {
    throw new QueryError({
      message: `insert into "${info.name}" requires at least one column`,
    })
  }

  const rawValues = rows.map((row) =>
    columnSet.map((col) => (Object.hasOwn(row, col) ? row[col] : undefined)),
  )

  const values = mapWriteParams(handle, mapper, columnSet, rawValues)
  return {
    kind: 'insert',
    relation: info.relation,
    columns: columnSet,
    values,
    ...(conflict ? { conflict: mapConflictParams(handle, mapper, conflict) } : {}),
    ...(returning ? { returning } : {}),
  }
}

type UpdateBuilderOptions<THandle extends TableHandle> = {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  patch: Record<string, unknown>
  where?: PredicateAst
  allowAll: boolean
  returning?: ReturningAst
}

/**
 * Builds an update AST after enforcing explicit full-table permission or a filter.
 *
 * @param options - Configuration and dependencies for this operation.
 * @param query - Resolved query compilation and relation-member lookup operations.
 *
 * @returns An update AST after enforcing explicit full-table permission or a filter.
 */
function buildUpdateAst<THandle extends TableHandle>(
  options: UpdateBuilderOptions<THandle>,
  query: DialectQueryResolution,
): UpdateAst {
  const { handle, mapper, patch, where, allowAll, returning } = options
  const info = handle.getTableMetadata()
  recordQueryRelation(info.relation, handle)

  if (where && allowAll) {
    throw new QueryError({
      message: `update on "${info.name}" cannot combine where(...) and .all()`,
    })
  }

  if (!where && !allowAll) {
    throw new QueryError({
      message: `update on "${info.name}" requires where(...) or .all()`,
    })
  }

  const set: UpdateAst['set'] = Object.entries(patch).map(([column, value]) =>
    isAddition(value)
      ? { column, addition: { source: value.column.column, delta: value.delta } }
      : { column, value: mapper ? mapper.mapParam(handle, column, value) : value },
  )

  return {
    kind: 'update',
    relation: info.relation,
    set,
    ...(where ? prepareWriteScope(query, handle, mapper, options.executor, where) : {}),
    allowAll,
    ...(returning ? { returning } : {}),
  }
}

type DeleteBuilderOptions<THandle extends TableHandle> = {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  where?: PredicateAst
  allowAll: boolean
  returning?: ReturningAst
}

/**
 * Builds a delete AST after enforcing explicit full-table permission or a filter.
 *
 * @param options - Configuration and dependencies for this operation.
 * @param query - Resolved query compilation and relation-member lookup operations.
 *
 * @returns A delete AST after enforcing explicit full-table permission or a filter.
 */
function buildDeleteAst<THandle extends TableHandle>(
  options: DeleteBuilderOptions<THandle>,
  query: DialectQueryResolution,
): DeleteAst {
  const { handle, mapper, where, allowAll, returning } = options
  const info = handle.getTableMetadata()
  recordQueryRelation(info.relation, handle)

  if (where && allowAll) {
    throw new QueryError({
      message: `delete from "${info.name}" cannot combine where(...) and .all()`,
    })
  }

  if (!where && !allowAll) {
    throw new QueryError({
      message: `delete from "${info.name}" requires where(...) or .all()`,
    })
  }

  return {
    kind: 'delete',
    relation: info.relation,
    ...(where ? prepareWriteScope(query, handle, mapper, options.executor, where) : {}),
    allowAll,
    ...(returning ? { returning } : {}),
  }
}

type SelectBuilderOptions<THandle extends TableHandle> = {
  handle: THandle
  dialect: Dialect
  query: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  state: SelectState
}

type TableBuilderOptions<THandle extends TableHandle> = {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
}

/**
 * Adds first-result operations while preserving writes that have no returning clause.
 *
 * @param execute - Callback that executes the current query or write.
 * @param returning - Requested returning columns, or undefined when the write returns no
 *   rows.
 * @param operation - Work to run within the current session or error boundary.
 *
 * @returns Write execution methods preserving the distinction between returned rows and a
 *   write result.
 */
function writeResultTerminals(
  execute: () => Promise<unknown>,
  returning: ReturningAst | undefined,
  operation: string,
) {
  return {
    /** Executes the query and returns its first row, or undefined when no row exists. */
    executeTakeFirst: async () => {
      const result = await execute()
      return returning ? (result as unknown[])[0] : result
    },
    /** Executes the query and requires its first result. */
    executeTakeFirstOrThrow: async () => {
      const result = await execute()
      return returning
        ? takeFirstOrThrow(result as unknown[], 'No rows returned from ' + operation)
        : result
    },
  }
}

/**
 * Adds immutable selection operations to the current select state.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param next - Factory for a fresh builder with the supplied state changes.
 *
 * @returns Immutable selectAll and select operations preserving prior clauses.
 */
function createSelectSelection<THandle extends TableHandle>(
  state: SelectState,
  next: (patch: Partial<SelectState>) => SelectBuilder<THandle, unknown>,
): Pick<SelectBuilder<THandle, unknown>, 'selectAll' | 'select'> {
  return {
    /**
     * Appends an all-columns selection.
     *
     * @param side - Optional joined table to select from.
     */
    selectAll(side?: TableHandle) {
      const metadata = side?.getTableMetadata()
      const item: SelectItemAst = metadata
        ? {
            kind: 'all',
            relation: metadata.relation,
          }
        : { kind: 'all' }

      return next({ selection: [...state.selection, item] }) as never
    },

    /**
     * Appends selected columns or expressions.
     *
     * @param input - Selection list or selection factory.
     */
    select(input: SelectSelectionInput) {
      return next({
        selection: [...state.selection, ...normalizeSelection(input)],
      }) as never
    },
  }
}

/**
 * Adds filters while combining existing predicates with AND.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param next - Factory for a fresh builder with the supplied state changes.
 *
 * @returns An immutable where operation that combines predicates using AND.
 */
function createSelectFilters<THandle extends TableHandle>(
  state: SelectState,
  next: (patch: Partial<SelectState>) => SelectBuilder<THandle, unknown>,
): Pick<SelectBuilder<THandle, unknown>, 'where'> {
  return {
    /**
     * Appends a where predicate.
     *
     * @param args - Supported where arguments.
     */
    where(...args: unknown[]) {
      let pred: PredicateAst

      if (args.length === 1) {
        const arg = args[0]

        if (typeof arg === 'function') {
          pred = (arg as (builder: ExpressionBuilder) => PredicateAst)(eb)
        } else {
          pred = normalizeWhere(arg as WhereInput)
        }
      } else {
        pred = normalizeWhere([
          args[0] as ColumnRef | string,
          args[1] as ComparisonOp,
          args[2],
        ])
      }

      return next({ where: mergeWhere(state.where, pred) }) as never
    },
  }
}

/** Adds cursor boundaries through the same immutable predicate state as WHERE. */
function createSelectBoundaries<THandle extends TableHandle>(
  state: SelectState,
  next: (patch: Partial<SelectState>) => SelectBuilder<THandle, unknown>,
): Pick<SelectBuilder<THandle, unknown>, 'after' | 'before'> {
  return {
    /** Adds a boundary after the cursor without changing the query order. */
    after(order, values) {
      return next({ where: mergeWhere(state.where, after(order, values)) }) as never
    },
    /** Adds a boundary before the cursor without changing the query order. */
    before(order, values) {
      return next({ where: mergeWhere(state.where, before(order, values)) }) as never
    },
  }
}

/**
 * Adds grouping and HAVING clauses without mutating the current builder.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param next - Factory for a fresh builder with the supplied state changes.
 *
 * @returns Immutable grouping and HAVING operations preserving prior clauses.
 */
function createSelectGrouping<THandle extends TableHandle>(
  state: SelectState,
  next: (patch: Partial<SelectState>) => SelectBuilder<THandle, unknown>,
): Pick<SelectBuilder<THandle, unknown>, 'groupBy' | 'having'> {
  return {
    /**
     * Appends grouping columns.
     *
     * @param columns - Columns to group by.
     */
    groupBy(columns) {
      const list = Array.isArray(columns) ? columns : [columns]
      return next({
        groupBy: [
          ...state.groupBy,
          ...list.map((c) => toQualified(c as ColumnRef | string)),
        ],
      }) as never
    },

    /**
     * Appends a having predicate.
     *
     * @param input - Predicate or predicate factory.
     */
    having(input: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst)) {
      const pred = typeof input === 'function' ? input(eb) : input
      return next({
        having: state.having ? and(state.having, pred) : pred,
      }) as never
    },
  }
}

/**
 * Starts table queries with selections or filters rooted at the registered handle.
 *
 * @param rootSelect - Factory for a select builder rooted at the table handle.
 *
 * @returns Root-table selection and filtering entry points.
 */
function createTableSelection<THandle extends TableHandle>(
  rootSelect: () => SelectBuilder<THandle, unknown>,
): Pick<QueryBuilder<THandle>, 'selectAll' | 'select' | 'where' | 'after' | 'before'> {
  return {
    /**
     * Selects every column from the root or a joined table.
     *
     * @param tableHandle - Optional table to select from.
     */
    selectAll(tableHandle?: TableHandle) {
      return rootSelect().selectAll(tableHandle as never) as never
    },

    /**
     * Selects columns or expressions.
     *
     * @param input - Selection list or selection factory.
     */
    select(input: SelectSelectionInput) {
      return rootSelect().select(input as never) as never
    },

    /** Starts a select query after the cursor without adding ORDER BY clauses. */
    after(order, values) {
      return rootSelect().after(order, values) as never
    },

    /** Starts a select query before the cursor without adding ORDER BY clauses. */
    before(order, values) {
      return rootSelect().before(order, values) as never
    },

    /**
     * Starts a filtered select query.
     *
     * @param args - Supported where arguments.
     */
    where(...args: unknown[]) {
      return (rootSelect().where as (...a: unknown[]) => SelectBuilder)(...args) as never
    },
  }
}

/**
 * Starts table queries with inner, left, or right joins.
 *
 * @param rootSelect - Factory for a select builder rooted at the table handle.
 *
 * @returns Root-table inner, left, and right join entry points.
 */
function createTableJoins<THandle extends TableHandle>(
  rootSelect: () => SelectBuilder<THandle, unknown>,
): Pick<QueryBuilder<THandle>, 'innerJoin' | 'leftJoin' | 'rightJoin'> {
  return {
    /**
     * Starts an inner join query.
     *
     * @param table - Table to join.
     * @param on - Join predicate input.
     */
    innerJoin(table, on) {
      return rootSelect().innerJoin(table, on) as never
    },

    /**
     * Starts a left join query.
     *
     * @param table - Table to join.
     * @param on - Join predicate input.
     */
    leftJoin(table, on) {
      return rootSelect().leftJoin(table, on) as never
    },

    /**
     * Starts a right join query.
     *
     * @param table - Table to join.
     * @param on - Join predicate input.
     */
    rightJoin(table, on) {
      return rootSelect().rightJoin(table, on) as never
    },
  }
}

/**
 * Starts table queries with ordering, row limits, or row offsets.
 *
 * @param rootSelect - Factory for a select builder rooted at the table handle.
 *
 * @returns Root-table ordering, limit, and offset entry points.
 */
function createTablePagination<THandle extends TableHandle>(
  rootSelect: () => SelectBuilder<THandle, unknown>,
): Pick<QueryBuilder<THandle>, 'orderBy' | 'limit' | 'offset' | 'groupBy' | 'having'> {
  return {
    /**
     * Starts an ordered select query.
     *
     * @param column - Column to order by.
     * @param direction - Optional sort direction.
     */
    orderBy(column, direction, nulls) {
      return rootSelect().orderBy(column, direction, nulls) as never
    },

    /**
     * Starts a limited select query.
     *
     * @param count - Maximum rows to return.
     */
    limit(count) {
      return rootSelect().limit(count) as never
    },

    /**
     * Starts an offset select query.
     *
     * @param count - Rows to skip.
     */
    offset(count) {
      return rootSelect().offset(count) as never
    },
    ...createTableGrouping(rootSelect),
  }
}

/**
 * Registers a unique output column.
 *
 * @param outputName - Output column name.
 * @param mapping - Optional source-column mapping.
 */
function addOutputColumn(
  outputName: string,
  mapping: ResultColumn | undefined,
  outputNames: Set<string>,
  columns: Map<string, ResultColumn>,
) {
  if (outputNames.has(outputName)) {
    throw new QueryError({
      message: `select output column "${outputName}" is ambiguous; alias one of the selected columns`,
    })
  }

  outputNames.add(outputName)

  if (mapping) columns.set(outputName, mapping)
}

/**
 * Adds returning clauses without mutating the current write builder.
 *
 * @param next - Factory for a fresh builder with the supplied state changes.
 *
 * @returns Immutable returning operations for all or selected affected-row columns.
 */
function createWriteReturning(
  next: (changes: { returning: ReturningAst | undefined }) => unknown,
) {
  return {
    /** Returns a builder configured to report only the affected-row count. */
    returningNone() {
      return next({ returning: undefined }) as never
    },
    /** Returns a builder configured to return every column. */
    returningAll() {
      return next({ returning: { kind: 'all' } }) as never
    },

    /**
     * Returns a builder configured to return selected columns.
     *
     * @param columns - Columns to return.
     */
    returning(columns: readonly (ColumnRef | string)[]) {
      return next({
        returning: { kind: 'columns', columns: resolveReturningColumns(columns) },
      }) as never
    },
  }
}

/**
 * Adds write filters and explicit permission for an operation that affects every row.
 *
 * @param where - Current filter predicate, if one has been supplied.
 * @param next - Factory for a fresh builder with the supplied state changes.
 *
 * @returns Immutable write filters and explicit permission to affect every row.
 */
function createWriteFilters(
  where: PredicateAst | undefined,
  next: (changes: { where?: PredicateAst; allowAll?: boolean }) => unknown,
) {
  /** Combines an additional write predicate with the current filter. */
  const withWhere = (input: WhereInput) =>
    next({ where: mergeWhere(where, normalizeWhere(input)) })

  return {
    /**
     * Returns a builder with an additional predicate.
     *
     * @param args - Supported where arguments.
     */
    where(...args: unknown[]) {
      if (args.length === 1) {
        return withWhere(args[0] as WhereInput) as never
      }

      return withWhere([
        args[0] as ColumnRef | string,
        args[1] as ComparisonOp,
        args[2],
      ]) as never
    },

    /** Allows the update to affect every row. */
    all() {
      return next({ allowAll: true }) as never
    },
  }
}

/**
 * Registers every column from a table handle.
 *
 * @param handle - Handle whose columns are registered.
 */
function addAllOutputColumns(
  handle: TableHandle,
  add: (outputName: string, mapping?: ResultColumn) => void,
) {
  for (const column of Object.keys(handle.getSchema().entries)) {
    add(column, { handle, column })
  }
}

/** Executes the select and requires a row. */
async function takeFirstSelectRow(execute: () => Promise<unknown>) {
  const rows = (await execute()) as unknown[]
  return takeFirstOrThrow(rows, 'No rows returned from select')
}

/**
 * Starts table queries with grouping or HAVING clauses.
 *
 * @param rootSelect - Factory for a select builder rooted at the table handle.
 *
 * @returns Root-table grouping and HAVING entry points.
 */
function createTableGrouping<THandle extends TableHandle>(
  rootSelect: () => SelectBuilder<THandle, unknown>,
): Pick<QueryBuilder<THandle>, 'groupBy' | 'having'> {
  return {
    /**
     * Starts a grouped select query.
     *
     * @param columns - Columns to group by.
     */
    groupBy(columns) {
      return rootSelect().groupBy(columns) as never
    },

    /**
     * Starts a select query with a having predicate.
     *
     * @param input - Predicate or predicate factory.
     */
    having(input: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst)) {
      return rootSelect().having(input as never) as never
    },
  }
}

type SelectionItem =
  | ColumnRef
  | string
  | { expr: SqlExprAst; alias: string }
  | SelectItemAst

type InferCallbackSelection<H, I extends readonly SelectionItem[], N> = {
  [
    K in I[number] as K extends { alias: infer A extends string }
      ? A
      : K extends ColumnRef<string, infer C>
        ? C
        : K extends string
          ? K
          : K extends { kind: 'column'; column: infer C extends string }
            ? C
            : never
  ]: K extends { expr: infer E }
    ? E extends { readonly __source?: infer C extends ColumnRef }
      ? InferSelectedColumns<H, readonly [C], N>[keyof InferSelectedColumns<
          H,
          readonly [C],
          N
        >]
      : E extends { readonly __value?: infer V }
        ? V
        : unknown
    : K extends { readonly __source?: infer C extends ColumnRef }
      ? InferSelectedColumns<H, readonly [C], N>[keyof InferSelectedColumns<
          H,
          readonly [C],
          N
        >]
      : K extends ColumnRef | string
        ? InferSelectedColumns<H, readonly [K], N>[keyof InferSelectedColumns<
            H,
            readonly [K],
            N
          >]
        : unknown
}

const authoredSelects = new WeakMap<
  SelectAst,
  { handles: readonly TableHandle[]; query: DialectQueryResolution; mapper?: ValueMapper }
>()

type PreparedRelation = RelationIdentityInput & { queryAlias?: string }
type ScopeEntry = { handle: TableHandle; relation: PreparedRelation }

function prepareStatement(root: SelectAst, owner: object): SelectAst {
  return new StatementPreparation(owner).prepare(root, [])
}

class StatementPreparation {
  private sequence = 0
  constructor(readonly owner: object) {}
  relation(handle: TableHandle): PreparedRelation {
    const relation = {
      ...handle.getTableMetadata().relation,
      queryAlias: `__stratom_q${this.sequence++}`,
    }

    recordQueryRelation(relation, handle)
    return relation
  }
  prepare(node: SelectAst, enclosing: readonly (readonly ScopeEntry[])[]): SelectAst {
    return new SelectPreparation(this, node, enclosing).prepare()
  }
}

class SelectPreparation {
  readonly handles: readonly TableHandle[]
  readonly query: DialectQueryResolution
  readonly mapper: ValueMapper | undefined
  readonly scope: readonly ScopeEntry[]
  constructor(
    readonly statement: StatementPreparation,
    readonly node: SelectAst,
    readonly enclosing: readonly (readonly ScopeEntry[])[],
  ) {
    const context = authoredSelects.get(node)

    if (!context) throw new InvariantError('Missing authored select context')

    this.handles = context.handles
    this.query = context.query
    this.mapper = context.mapper

    const names = this.handles
      .map((h) => occurrenceAlias(h.getTableMetadata().relation))
      .filter((n) => n !== undefined)

    if (new Set(names).size !== names.length)
      throw new QueryError({ message: 'Duplicate relation aliases in query' })

    const nested = enclosing.length > 0 || hasNested(node) || names.length > 0
    this.scope = this.handles.map((handle) => ({
      handle,
      relation: nested ? statement.relation(handle) : handle.getTableMetadata().relation,
    }))
  }
  resolve(
    ref: QualifiedColumnAst,
    available: readonly ScopeEntry[] = this.scope,
  ): { entry: ScopeEntry; column: string } {
    const handle = findHandle(
      this.query,
      available.map((e) => e.handle),
      ref.relation,
    )

    return {
      entry: available.find((e) => e.handle === handle)!,
      column: findColumn(this.query, handle, ref.column, ref.relation),
    }
  }
  column(
    ref: QualifiedColumnAst,
    available: readonly ScopeEntry[] = this.scope,
  ): QualifiedColumnAst {
    const found = this.resolve(ref, available)
    return { column: found.column, relation: found.entry.relation }
  }
  inner(
    placeholder: SelectAst,
    single: boolean,
    available: readonly ScopeEntry[],
  ): SelectAst {
    const builder = nestedDefinitions.get(placeholder)
    const definition = builder && selectDefinitions.get(builder)

    if (!definition)
      throw new QueryError({ message: 'Subqueries require a select builder' })

    if (definition.owner !== this.statement.owner)
      throw new QueryError({ message: 'Subqueries must share the same client scope' })

    const result = this.statement.prepare(definition.build(), [
      available,
      ...this.enclosing,
    ])

    if (single && result.selection.length !== 1)
      throw new QueryError({
        message: 'Scalar and IN subqueries require exactly one projected value',
      })

    return result
  }
  outer(ref: QualifiedColumnAst): SqlExprAst {
    for (const parent of this.enclosing) {
      const matches =
        ref.relation && occurrenceAlias(ref.relation)
          ? parent.filter((e) => e.handle.getTableMetadata().relation === ref.relation)
          : this.query.findRelationMatches(
              ref.relation!,
              parent
                .map((e) => e.handle)
                .filter((h) => !occurrenceAlias(h.getTableMetadata().relation)),
            )

      if (matches.length > 0) return { kind: 'column', ...this.column(ref, parent) }
    }

    throw new QueryError({
      message: 'Outer column is not available in an enclosing scope',
    })
  }
  expression(
    expr: SqlExprAst,
    available: readonly ScopeEntry[] = this.scope,
  ): SqlExprAst {
    if (expr.kind === 'scalar')
      return { kind: 'scalar', query: this.inner(expr.query, true, available) }

    if (expr.kind === 'outer') return this.outer(expr.ref)
    if (expr.kind === 'column') return { kind: 'column', ...this.column(expr, available) }

    if ('arg' in expr)
      return { ...expr, arg: { kind: 'column', ...this.column(expr.arg, available) } }

    return expr
  }
  comparison(
    pred: Extract<PredicateAst, { kind: 'exprCmp' }>,
    available: readonly ScopeEntry[],
  ): PredicateAst {
    const left = this.expression(pred.left, available)
    let right =
      pred.right.kind === 'value' ? pred.right : this.expression(pred.right, available)
    const source = this.expressionSource(left)

    if (right.kind === 'value' && right.value !== null && this.mapper && source) {
      right = {
        kind: 'value',
        value: this.mapper.mapParam(baseTable(source.handle), source.column, right.value),
      }
    }

    return { ...pred, left, right }
  }
  predicate(
    pred: PredicateAst,
    available: readonly ScopeEntry[] = this.scope,
  ): PredicateAst {
    if (pred.kind === 'exists')
      return { kind: 'exists', query: this.inner(pred.query, false, available) }

    if (pred.kind === 'inQuery')
      return {
        kind: 'inQuery',
        left: this.expression(pred.left, available),
        query: this.inner(pred.query, true, available),
      }

    if (pred.kind === 'exprCmp') return this.comparison(pred, available)

    if (pred.kind === 'and' || pred.kind === 'or')
      return { ...pred, preds: pred.preds.map((p) => this.predicate(p, available)) }

    if (pred.kind === 'not')
      return { kind: 'not', pred: this.predicate(pred.pred, available) }

    const left = this.resolve(pred, available)
    return {
      ...pred,
      column: left.column,
      relation: left.entry.relation,
      ...(pred.right
        ? { right: this.column(pred.right, available) }
        : {
            value:
              pred.value === null || !this.mapper
                ? pred.value
                : this.mapper.mapParam(
                    baseTable(left.entry.handle),
                    left.column,
                    pred.value,
                  ),
          }),
    }
  }
  expressionSource(expr: SqlExprAst): ResultColumn | undefined {
    if (expr.kind === 'column') {
      const entry = [this.scope, ...this.enclosing]
        .flat()
        .find((e) => e.relation === expr.relation)

      return entry ? { handle: entry.handle, column: expr.column } : undefined
    }

    if (expr.kind === 'scalar') return preparedSources.get(expr.query)

    return undefined
  }
  selectionItem(item: SelectItemAst): SelectItemAst[] {
    if (item.kind === 'all') {
      const selected = item.relation
        ? this.scope.filter(
            (e) => e.handle === findHandle(this.query, this.handles, item.relation),
          )
        : this.scope

      return selected.flatMap((entry) =>
        Object.keys(entry.handle.getSchema().entries).map((name) => ({
          kind: 'column' as const,
          column: name,
          relation: entry.relation,
          alias: name,
        })),
      )
    }

    if (item.kind === 'column') return [{ ...item, ...this.column(item) }]

    return [{ ...item, expr: this.expression(item.expr) }]
  }
  prepare(): SelectAst {
    const { node, query, handles, mapper } = this

    if (
      !hasNested(node) &&
      this.enclosing.length === 0 &&
      !handles.some((h) => occurrenceAlias(h.getTableMetadata().relation))
    ) {
      return {
        ...node,
        ...(node.joins
          ? { joins: mapJoinsParams(query, handles, mapper, node.joins) }
          : {}),
        ...(node.where
          ? { where: mapPredicateParams(query, handles, mapper, node.where) }
          : {}),
        ...(node.having
          ? { having: mapPredicateParams(query, handles, mapper, node.having) }
          : {}),
      }
    }

    const selection = node.selection.flatMap((item) => this.selectionItem(item))
    const result: SelectAst = {
      ...node,
      relation: this.scope[0]!.relation,
      selection,
      ...(node.joins
        ? {
            joins: node.joins.map((j, i) => ({
              ...j,
              relation: this.scope[i + 1]!.relation,
              on: this.predicate(j.on, this.scope.slice(0, i + 2)),
            })),
          }
        : {}),
      ...(node.where ? { where: this.predicate(node.where) } : {}),
      ...(node.having ? { having: this.predicate(node.having) } : {}),
      ...(node.orderBy
        ? { orderBy: node.orderBy.map((c) => ({ ...c, ...this.column(c) })) }
        : {}),
      ...(node.groupBy ? { groupBy: node.groupBy.map((c) => this.column(c)) } : {}),
    }

    return this.recordSource(result)
  }

  recordSource(result: SelectAst): SelectAst {
    const first = result.selection[0]!
    const source =
      first.kind === 'column'
        ? this.expressionSource(first)
        : first.kind === 'expr'
          ? this.expressionSource(first.expr)
          : undefined

    const columns = new Map<string, ResultColumn>()
    for (const item of result.selection) {
      const mapping =
        item.kind === 'column'
          ? this.expressionSource(item)
          : item.kind === 'expr'
            ? this.expressionSource(item.expr)
            : undefined

      if (mapping && item.kind !== 'all')
        columns.set(
          item.alias ?? (item.kind === 'column' ? item.column : ''),
          item.kind === 'expr' && item.expr.kind === 'scalar'
            ? { ...mapping, scalar: true }
            : mapping,
        )
    }

    preparedColumns.set(result, columns)

    if (source) preparedSources.set(result, source)

    return result
  }
}
const preparedColumns = new WeakMap<SelectAst, Map<string, ResultColumn>>()
const preparedSources = new WeakMap<SelectAst, ResultColumn>()

function hasNested(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false

  if (
    'kind' in node &&
    ['scalar', 'inQuery', 'exists', 'outer'].includes(String(node.kind))
  )
    return true

  return Object.entries(node).some(
    ([key, value]) =>
      key !== 'value' &&
      key !== 'values' &&
      (Array.isArray(value) ? value.some(hasNested) : hasNested(value)),
  )
}

function prepareWriteScope(
  query: DialectQueryResolution,
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  owner: object,
  where: PredicateAst,
): Pick<SelectAst, 'relation' | 'where'> {
  const node: SelectAst = {
    kind: 'select',
    relation: handle.getTableMetadata().relation,
    selection: [{ kind: 'all' }],
    where,
  }

  authoredSelects.set(node, { handles: [handle], query, mapper })
  const prepared = prepareStatement(node, owner)

  return { relation: prepared.relation, where: prepared.where! }
}

async function executeSelect(options: SelectBuilderOptions<TableHandle>) {
  const { ast, resultColumns } = buildSelectQuery(options)
  const prepared = prepareStatement(ast, options.executor)
  return runQuery(
    options.query,
    options.executor,
    options.handle,
    options.mapper,
    preparedColumns.get(prepared) ?? resultColumns,
    prepared,
  )
}
