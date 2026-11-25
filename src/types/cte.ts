import type { RelationIdentityInput } from '@/schemas'

import type { ColumnRef, ReadSource } from './tableHandle'

declare const cteRow: unique symbol

type CteHandle<
  R = Record<string, unknown>,
  N extends string = string,
  TRelation extends RelationIdentityInput = { readonly relation: N; readonly cte: true },
> = {
  getSchema(): ReturnType<ReadSource['getSchema']>
  getTableMetadata(): { name: N; relation: TRelation }
  readonly [cteRow]: R
} & (string extends keyof R
  ? unknown
  : { readonly [K in keyof R & string]: ColumnRef<N, K, R[K], TRelation> })

const cteAliases = new WeakMap<object, ReadSource>()
const cteHandles = new WeakSet()

export type { CteHandle, cteRow }
export { cteAliases, cteHandles }
