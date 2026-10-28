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

import type { Executor } from './executor'
import type { ExpressionBuilder } from './expressions'
import { and, cmp, columnName, columnRelation, eb, toQualified } from './expressions'
import type { ValueMapper } from './mapping'
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

export type CompiledQuery = { sql: string; params: unknown[] }

type WhereInput =
  | PredicateAst
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
  return typeof kind === 'string' && ['cmp', 'and', 'or', 'not'].includes(kind)
}

/**
 * Normalizes supported where inputs into a predicate AST.
 *
 * @param input - Where input to normalize.
 */
function normalizeWhere(input: WhereInput): PredicateAst {
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
 * Maps SET clause parameters through the value mapper.
 *
 * @example
 *   mapSetParams(handle, mapper, [{ column: 'name', value: 'Alice' }])
 *
 * @param handle - Table handle for column metadata.
 * @param mapper - Value mapper for parameter conversion.
 * @param set - SET items with column names and values.
 *
 * @returns Mapped SET items
 */
function mapSetParams(
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  set: readonly { readonly column: string; readonly value: unknown }[],
): readonly { readonly column: string; readonly value: unknown }[] {
  if (!mapper) return set

  return set.map((item) => ({
    column: item.column,
    value: mapper.mapParam(handle, item.column, item.value),
  }))
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

  const matches = query.findRelationMatches(relation, handles)

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

type ResultColumn = { handle: TableHandle; column: string }

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

    const output: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(row)) {
      const mapping = columns.get(key)
      output[key] = mapping
        ? mapper.mapResultValue(mapping.handle, mapping.column, value)
        : value
    }

    return output
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
  const rows = await executeQueryOperation(ast, () => executor.execute(compiled))

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
    const rows = await executeQueryOperation(ast, () => executor.execute(compiled))
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
  const compile = () => query.compile(buildAst())

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
   *   expressions may fail during execution.
   */
  set(patch: InferUpdate<THandle>): UpdateBuilder<THandle, InferSelect<THandle>>
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
    predicate: Record<string, unknown> | PredicateAst,
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
  const compile = () => query.compile(buildAst())

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
    predicate: Record<string, unknown> | PredicateAst,
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
  const compile = () => query.compile(buildAst())

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
> = {
  /**
   * Selects every column from the root or requested joined table.
   *
   * @returns A fresh select builder including all columns of the selected table.
   */
  selectAll(): SelectBuilder<
    THandle,
    MergeSelection<HasSelection, TResult, InferSelectAllSide<THandle, TNullable>>,
    true,
    TNullable
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
    TNullable
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
    TNullable
  >
  /**
   * Adds selected columns or expressions to the query's result shape.
   *
   * @param callback - Work to run within the owned client or session scope.
   *
   * @returns A fresh select builder with the requested columns or expressions added.
   */
  select(
    callback: (
      builder: ExpressionBuilder,
    ) => readonly (
      | ColumnRef
      | string
      | { expr: SqlExprAst; alias: string }
      | SelectItemAst
    )[],
  ): SelectBuilder<THandle, Record<string, unknown>, true, TNullable>
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
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
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
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  /**
   * Adds an ordering clause with an ascending or descending direction.
   *
   * @param column - Column reference or authored name used to address the query member.
   * @param direction - Ascending or descending sort direction.
   *
   * @returns A fresh select builder with the requested sort clause appended.
   */
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  /**
   * Sets the maximum number of result rows.
   *
   * @param count - Row limit or offset count for the requested query operation.
   *
   * @returns A fresh select builder with the requested row limit.
   */
  limit(count: number): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  /**
   * Sets the number of result rows to skip.
   *
   * @param count - Number of result rows to skip before returning rows.
   *
   * @returns A fresh select builder with the requested row offset.
   */
  offset(count: number): SelectBuilder<THandle, TResult, HasSelection, TNullable>
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
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  /**
   * Adds a predicate evaluated against grouped query results.
   *
   * @param predicate - Predicate or predicate factory used to filter query results.
   *
   * @returns A fresh select builder with the requested grouped-result predicate.
   */
  having(
    predicate: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
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
    TNullable
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
    TNullable | TableIdentityOf<TSide>
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
    TNullable | TableIdentityOf<THandle>
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
function buildSelectQuery(options: {
  handle: TableHandle
  query: DialectQueryResolution
  mapper?: ValueMapper
  state: SelectState
}) {
  const { handle, query, mapper, state } = options
  const info = handle.getTableMetadata()
  const handles = [handle, ...state.joinedHandles]
  const selection =
    state.selection.length === 0 ? [{ kind: 'all' } as const] : state.selection

  const resultColumns = resultColumnsForSelection(query, handles, selection)
  const ast: SelectAst = {
    kind: 'select',
    relation: info.relation,
    selection,
    ...(state.joins.length > 0
      ? { joins: mapJoinsParams(query, handles, mapper, state.joins) }
      : {}),
    ...(state.where
      ? { where: mapPredicateParams(query, handles, mapper, state.where) }
      : {}),
    ...(state.orderBy.length > 0 ? { orderBy: state.orderBy } : {}),
    ...(state.limit !== undefined ? { limit: state.limit } : {}),
    ...(state.offset !== undefined ? { offset: state.offset } : {}),
    ...(state.groupBy.length > 0 ? { groupBy: state.groupBy } : {}),
    ...(state.having
      ? { having: mapPredicateParams(query, handles, mapper, state.having) }
      : {}),
  }

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
    orderBy(column, direction: 'asc' | 'desc' = 'asc') {
      const q = toQualified(column)
      return next({
        orderBy: [
          ...state.orderBy,
          {
            column: q.column,
            ...(q.relation !== undefined ? { relation: q.relation } : {}),
            direction,
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
  const compile = () => query.compile(buildSelectQuery(options).ast)

  /** Executes the current select query. */
  const execute = async () => {
    const { ast, resultColumns } = buildSelectQuery(options)
    return runQuery(query, executor, handle, mapper, resultColumns, ast)
  }

  /** Executes the select and returns its first row. */
  const executeTakeFirst = async () => {
    const rows = (await execute()) as unknown[]
    return rows[0]
  }

  /** Executes the query and requires its first result. */
  const executeTakeFirstOrThrow = () => takeFirstSelectRow(execute)

  return {
    ...createSelectSelection(state, next),
    ...createSelectFilters(state, next),
    ...createSelectPagination(state, next),
    ...createSelectGrouping(state, next),
    ...createSelectJoins(state, next),
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Root table query builder
// ---------------------------------------------------------------------------

/**
 * Fluent query builder rooted on a registered table handle.
 * Default terminal path is `select *`; use insert/update/delete for writes.
 */
export type QueryBuilder<THandle extends TableHandle = TableHandle> = {
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
  selectAll(): SelectBuilder<THandle, InferSelect<THandle>, true>
  /**
   * Selects every column from the root or requested joined table.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   *
   * @returns A fresh select builder including all columns of the selected table.
   */
  selectAll<TSide extends TableHandle>(
    handle: TSide,
  ): SelectBuilder<THandle, InferSelect<TSide>, true>
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
  ): SelectBuilder<THandle, InferSelectedColumns<THandle, TCols>, true>
  /**
   * Adds selected columns or expressions to the query's result shape.
   *
   * @param callback - Work to run within the owned client or session scope.
   *
   * @returns A fresh select builder with the requested columns or expressions added.
   */
  select(
    callback: (
      builder: ExpressionBuilder,
    ) => readonly (
      | ColumnRef
      | string
      | { expr: SqlExprAst; alias: string }
      | SelectItemAst
    )[],
  ): SelectBuilder<THandle, Record<string, unknown>, true>
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
  ): SelectBuilder<THandle, InferSelect<THandle> & InferSelect<TSide>>
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
    TableIdentityOf<TSide>
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
    TableIdentityOf<THandle>
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
   * Adds an ordering clause with an ascending or descending direction.
   *
   * @param column - Column reference or authored name used to address the query member.
   * @param direction - Ascending or descending sort direction.
   *
   * @returns A fresh select builder with the requested sort clause appended.
   */
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
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

  return {
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

  const set = mapSetParams(
    handle,
    mapper,
    Object.entries(patch).map(([column, value]) => ({ column, value })),
  )

  return {
    kind: 'update',
    relation: info.relation,
    set,
    ...(where ? { where: mapPredicateParams(query, [handle], mapper, where) } : {}),
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
    ...(where ? { where: mapPredicateParams(query, [handle], mapper, where) } : {}),
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
): Pick<QueryBuilder<THandle>, 'selectAll' | 'select' | 'where'> {
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
    orderBy(column, direction) {
      return rootSelect().orderBy(column, direction) as never
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
