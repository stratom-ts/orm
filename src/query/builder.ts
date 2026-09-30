import type {
  ComparisonOp,
  DeleteAst,
  Dialect,
  DialectQueryResolution,
  InsertAst,
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
import type { RelationIdentityInput } from '@/schemas'
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
import { QueryError } from '@/utils/error'

import type { Executor } from './executor'
import type { ExpressionBuilder } from './expressions'
import { and, cmp, columnName, columnRelation, eb, toQualified } from './expressions'
import type { ValueMapper } from './mapping'

/** Result when a write runs without `returning`. */
export type WriteResult = {
  rowCount: number
}

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
 * @param dialect - Selected dialect query semantics.
 * @param handles - Table handles to search.
 * @param relation - Optional authored relation intent.
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
 * @param dialect - Selected dialect query semantics.
 * @param handle - Handle whose columns are being addressed.
 * @param column - Authored column spelling to resolve.
 * @param relation - Optional authored relation for diagnostics.
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

  /**
   * Registers a unique output column.
   *
   * @param outputName - Output column name.
   * @param mapping - Optional source-column mapping.
   */
  const add = (outputName: string, mapping?: ResultColumn) => {
    if (outputNames.has(outputName)) {
      throw new QueryError({
        message: `select output column "${outputName}" is ambiguous; alias one of the selected columns`,
      })
    }

    outputNames.add(outputName)

    if (mapping) columns.set(outputName, mapping)
  }

  /**
   * Registers every column from a table handle.
   *
   * @param handle - Handle whose columns are registered.
   */
  const addAll = (handle: TableHandle) => {
    for (const column of Object.keys(handle.getSchema().entries)) {
      add(column, { handle, column })
    }
  }

  const addHandles = (selectedHandles: readonly TableHandle[]) => {
    for (const handle of selectedHandles) addAll(handle)
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
 * @param dialect - SQL dialect for compilation.
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

  try {
    const rows = await executor.execute(compiled)

    if (mapper && ast.kind === 'select') {
      return mapSelectedRows(mapper, rows, resultColumns) as T
    }

    if (mapper && 'returning' in ast && ast.returning) {
      return mapper.mapResultRows(handle, rows) as T
    }

    return rows as T
  } catch (cause) {
    if (cause instanceof QueryError) throw cause

    throw new QueryError({
      message: cause instanceof Error ? cause.message : 'Query execution failed',
      cause,
    })
  }
}

/**
 * Compiles and executes a write AST (INSERT/UPDATE/DELETE), returning rows or a write
 * result.
 *
 * @example
 *   const result = await runWrite(dialect, executor, handle, mapper, insertAst)
 *
 * @param dialect - SQL dialect for compilation.
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

  try {
    if (ast.returning) {
      const rows = await executor.execute(compiled)
      return mapper ? mapper.mapResultRows(handle, rows) : rows
    }

    await executor.run(compiled)

    // db0 does not expose affected-row counts portably
    return { rowCount: 0 }
  } catch (cause) {
    if (cause instanceof QueryError) throw cause

    throw new QueryError({
      message: cause instanceof Error ? cause.message : 'Query execution failed',
      cause,
    })
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
  TResult = WriteResult,
> = {
  returningAll(): InsertBuilder<THandle, InferSelect<THandle>>
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): InsertBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  compile(): CompiledQuery
  execute(): Promise<TResult extends WriteResult ? WriteResult : TResult[]>
  executeTakeFirst(): Promise<
    TResult extends WriteResult ? WriteResult : TResult | undefined
  >
  executeTakeFirstOrThrow(): Promise<TResult extends WriteResult ? WriteResult : TResult>
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
export function createInsertBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  rows: Record<string, unknown>[]
  returning?: ReturningAst
}): InsertBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, rows, returning } = options
  const query = options.query ?? dialect.query.resolve([handle])

  /** Builds the insert AST. */
  const buildAst = (): InsertAst => {
    // Union of keys across rows (stable order: first row keys, then extras)
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

    // Missing keys become undefined → dialect emits DEFAULT (not NULL).
    const rawValues = rows.map((row) =>
      columnSet.map((col) => (Object.hasOwn(row, col) ? row[col] : undefined)),
    )
    const values = mapWriteParams(handle, mapper, columnSet, rawValues)

    return {
      kind: 'insert',
      relation: info.relation,
      columns: columnSet,
      values,
      ...(returning ? { returning } : {}),
    }
  }

  /** Compiles the current insert query. */
  const compile = () => query.compile(buildAst())

  /** Executes the current insert query. */
  const execute = async () => runWrite(query, executor, handle, mapper, buildAst())

  /**
   * Executes the insert and returns the first row when `returning` is configured.
   * Without `returning`, returns the full write result.
   */
  const executeTakeFirst = async () => {
    const result = await execute()

    if (returning) {
      return (result as unknown[])[0]
    }

    return result
  }

  /**
   * Executes the insert and requires a row when `returning` is configured.
   * Without `returning`, returns the full write result.
   */
  const executeTakeFirstOrThrow = async () => {
    const result = await execute()

    if (returning) {
      return takeFirstOrThrow(result as unknown[], 'No rows returned from insert')
    }

    return result
  }

  return {
    /** Returns a builder configured to return every column. */
    returningAll() {
      return createInsertBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        rows,
        returning: { kind: 'all' },
      }) as never
    },
    /**
     * Returns a builder configured to return selected columns.
     *
     * @param columns - Columns to return.
     */
    returning(columns) {
      return createInsertBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        rows,
        returning: {
          kind: 'columns',
          columns: resolveReturningColumns(columns),
        },
      }) as never
    },
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
  values(
    row: InferInsert<THandle> | InferInsert<THandle>[],
  ): InsertBuilder<THandle, InferSelect<THandle>>
}

// ---------------------------------------------------------------------------
// Update builder
// ---------------------------------------------------------------------------

export type UpdateSetBuilder<THandle extends TableHandle = TableHandle> = {
  set(patch: InferUpdate<THandle>): UpdateBuilder<THandle, InferSelect<THandle>>
}

export type UpdateBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = WriteResult,
> = {
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): UpdateBuilder<THandle, TResult>
  where(
    predicate: Record<string, unknown> | PredicateAst,
  ): UpdateBuilder<THandle, TResult>
  /** Opt into full-table update (no where). */
  all(): UpdateBuilder<THandle, TResult>
  returningAll(): UpdateBuilder<THandle, InferSelect<THandle>>
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): UpdateBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  compile(): CompiledQuery
  execute(): Promise<Prettify<TResult extends WriteResult ? WriteResult : TResult>[]>
  executeTakeFirst(): Promise<
    TResult extends WriteResult ? WriteResult : TResult | undefined
  >
  executeTakeFirstOrThrow(): Promise<TResult extends WriteResult ? WriteResult : TResult>
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
export function createUpdateBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  patch: Record<string, unknown>
  where?: PredicateAst
  allowAll: boolean
  returning?: ReturningAst
}): UpdateBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, patch, where, allowAll, returning } = options
  const query = options.query ?? dialect.query.resolve([handle])

  /** Builds the update AST. */
  const buildAst = (): UpdateAst => {
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

  /** Compiles the current update query. */
  const compile = () => query.compile(buildAst())

  /** Executes the current update query. */
  const execute = async () => runWrite(query, executor, handle, mapper, buildAst())

  /**
   * Executes the update and returns the first row when `returning` is configured.
   * Without `returning`, returns the full write result.
   */
  const executeTakeFirst = async () => {
    const result = await execute()

    if (returning) return (result as unknown[])[0]

    return result
  }

  /**
   * Executes the update and requires a row when `returning` is configured.
   * Without `returning`, returns the full write result.
   */
  const executeTakeFirstOrThrow = async () => {
    const result = await execute()

    if (returning) {
      return takeFirstOrThrow(result as unknown[], 'No rows returned from update')
    }

    return result
  }

  /**
   * Returns an update builder with an additional predicate.
   *
   * @param input - Predicate input to append.
   */
  const withWhere = (input: WhereInput) =>
    createUpdateBuilder({
      handle,
      dialect,
      query,
      executor,
      mapper,
      patch,
      where: mergeWhere(where, normalizeWhere(input)),
      allowAll,
      returning,
    })

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
      return createUpdateBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        patch,
        where,
        allowAll: true,
        returning,
      }) as never
    },
    /** Returns a builder configured to return every column. */
    returningAll() {
      return createUpdateBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        patch,
        where,
        allowAll,
        returning: { kind: 'all' },
      }) as never
    },
    /**
     * Returns a builder configured to return selected columns.
     *
     * @param columns - Columns to return.
     */
    returning(columns) {
      return createUpdateBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        patch,
        where,
        allowAll,
        returning: {
          kind: 'columns',
          columns: resolveReturningColumns(columns),
        },
      }) as never
    },
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
  TResult = WriteResult,
> = {
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): DeleteBuilder<THandle, TResult>
  where(
    predicate: Record<string, unknown> | PredicateAst,
  ): DeleteBuilder<THandle, TResult>
  /** Opt into full-table delete (no where). */
  all(): DeleteBuilder<THandle, TResult>
  returningAll(): DeleteBuilder<THandle, InferSelect<THandle>>
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): DeleteBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  compile(): CompiledQuery
  execute(): Promise<TResult extends WriteResult ? WriteResult : TResult[]>
  executeTakeFirst(): Promise<
    TResult extends WriteResult ? WriteResult : TResult | undefined
  >
  executeTakeFirstOrThrow(): Promise<TResult extends WriteResult ? WriteResult : TResult>
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
export function createDeleteBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  where?: PredicateAst
  allowAll: boolean
  returning?: ReturningAst
}): DeleteBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, where, allowAll, returning } = options
  const query = options.query ?? dialect.query.resolve([handle])

  /** Builds the delete AST. */
  const buildAst = (): DeleteAst => {
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

  /** Compiles the current delete query. */
  const compile = () => query.compile(buildAst())

  /** Executes the current delete query. */
  const execute = async () => runWrite(query, executor, handle, mapper, buildAst())

  /**
   * Executes the delete and returns the first row when `returning` is configured.
   * Without `returning`, returns the full write result.
   */
  const executeTakeFirst = async () => {
    const result = await execute()

    if (returning) return (result as unknown[])[0]

    return result
  }

  /**
   * Executes the delete and requires a row when `returning` is configured.
   * Without `returning`, returns the full write result.
   */
  const executeTakeFirstOrThrow = async () => {
    const result = await execute()

    if (returning) {
      return takeFirstOrThrow(result as unknown[], 'No rows returned from delete')
    }

    return result
  }

  /**
   * Returns a delete builder with an additional predicate.
   *
   * @param input - Predicate input to append.
   */
  const withWhere = (input: WhereInput) =>
    createDeleteBuilder({
      handle,
      dialect,
      query,
      executor,
      mapper,
      where: mergeWhere(where, normalizeWhere(input)),
      allowAll,
      returning,
    })

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
    /** Allows the delete to affect every row. */
    all() {
      return createDeleteBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        where,
        allowAll: true,
        returning,
      }) as never
    },
    /** Returns a builder configured to return every column. */
    returningAll() {
      return createDeleteBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        where,
        allowAll,
        returning: { kind: 'all' },
      }) as never
    },
    /**
     * Returns a builder configured to return selected columns.
     *
     * @param columns - Columns to return.
     */
    returning(columns) {
      return createDeleteBuilder({
        handle,
        dialect,
        query,
        executor,
        mapper,
        where,
        allowAll,
        returning: {
          kind: 'columns',
          columns: resolveReturningColumns(columns),
        },
      }) as never
    },
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
  selectAll(): SelectBuilder<
    THandle,
    MergeSelection<HasSelection, TResult, InferSelectAllSide<THandle, TNullable>>,
    true,
    TNullable
  >
  selectAll<TSide extends TableHandle>(
    handle: TSide,
  ): SelectBuilder<
    THandle,
    MergeSelection<HasSelection, TResult, InferSelectAllSide<TSide, TNullable>>,
    true,
    TNullable
  >
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
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  limit(count: number): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  offset(count: number): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  groupBy(
    columns: readonly (ColumnRef | string)[] | ColumnRef | string,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  having(
    predicate: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  innerJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    MergeJoinStar<HasSelection, TResult, InferSelect<TSide>>,
    HasSelection,
    TNullable
  >
  leftJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    MergeJoinStar<HasSelection, TResult, NullableFields<InferSelect<TSide>>>,
    HasSelection,
    TNullable | TableIdentityOf<TSide>
  >
  rightJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    HasSelection extends true ? TResult : RightJoinStarResult<THandle, TResult, TSide>,
    HasSelection,
    TNullable | TableIdentityOf<THandle>
  >
  compile(): CompiledQuery
  execute(): Promise<Prettify<TResult>[]>
  executeTakeFirst(): Promise<TResult | undefined>
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
function createSelectBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  query: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
  state: SelectState
}): SelectBuilder<THandle, unknown> {
  const { handle, dialect, query, executor, mapper, state } = options

  /** Builds the select AST and result-column mappings. */
  const buildQuery = () => {
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
      state: {
        selection: patch.selection ?? state.selection,
        joins: patch.joins ?? state.joins,
        joinedHandles: patch.joinedHandles ?? state.joinedHandles,
        where: 'where' in patch ? patch.where : state.where,
        orderBy: patch.orderBy ?? state.orderBy,
        limit: 'limit' in patch ? patch.limit : state.limit,
        offset: 'offset' in patch ? patch.offset : state.offset,
        groupBy: patch.groupBy ?? state.groupBy,
        having: 'having' in patch ? patch.having : state.having,
      },
    })

  /** Compiles the current select query. */
  const compile = () => query.compile(buildQuery().ast)

  /** Executes the current select query. */
  const execute = async () => {
    const { ast, resultColumns } = buildQuery()
    return runQuery(query, executor, handle, mapper, resultColumns, ast)
  }

  /** Executes the select and returns its first row. */
  const executeTakeFirst = async () => {
    const rows = (await execute()) as unknown[]
    return rows[0]
  }

  /** Executes the select and requires a row. */
  const executeTakeFirstOrThrow = async () => {
    const rows = (await execute()) as unknown[]
    return takeFirstOrThrow(rows, 'No rows returned from select')
  }

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
  /** Execute `select * from table`. */
  execute(): Promise<InferSelect<THandle>[]>
  executeTakeFirst(): Promise<InferSelect<THandle> | undefined>
  executeTakeFirstOrThrow(): Promise<InferSelect<THandle>>
  /** Explicit select-all (same as default execute path). */
  selectAll(): SelectBuilder<THandle, InferSelect<THandle>, true>
  selectAll<TSide extends TableHandle>(
    handle: TSide,
  ): SelectBuilder<THandle, InferSelect<TSide>, true>
  select<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): SelectBuilder<THandle, InferSelectedColumns<THandle, TCols>, true>
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
  innerJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<THandle, InferSelect<THandle> & InferSelect<TSide>>
  leftJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    InferSelect<THandle> & NullableFields<InferSelect<TSide>>,
    false,
    TableIdentityOf<TSide>
  >
  rightJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    NullableFields<InferSelect<THandle>> & InferSelect<TSide>,
    false,
    TableIdentityOf<THandle>
  >
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): SelectBuilder<THandle, InferSelect<THandle>>
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, InferSelect<THandle>>
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
  ): SelectBuilder<THandle, InferSelect<THandle>>
  limit(count: number): SelectBuilder<THandle, InferSelect<THandle>>
  offset(count: number): SelectBuilder<THandle, InferSelect<THandle>>
  groupBy(
    columns: readonly (ColumnRef | string)[] | ColumnRef | string,
  ): SelectBuilder<THandle, InferSelect<THandle>>
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
export function createTableBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  query?: DialectQueryResolution
  executor: Executor
  mapper?: ValueMapper
}): QueryBuilder<THandle> {
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
    /**
     * Starts a filtered select query.
     *
     * @param args - Supported where arguments.
     */
    where(...args: unknown[]) {
      return (rootSelect().where as (...a: unknown[]) => SelectBuilder)(...args) as never
    },
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
