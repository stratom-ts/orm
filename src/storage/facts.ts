import type { NumberConstraints, StringConstraints } from '@/types/constraints'

/** Logical value families, independent of validation libraries and SQL affinity. */
export type StorageOutputKind =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'json'

/** String meanings for which a dialect can select a native representation. */
export type StorageStringFormat =
  | 'uuid'
  | 'ip'
  | 'ipv4'
  | 'ipv6'
  | 'mac'
  | 'mac48'
  | 'mac64'
  | 'decimal'
  | 'iso_date'
  | 'iso_time'
  | 'iso_time_second'
  | 'iso_date_time'
  | 'iso_date_time_second'
  | 'iso_timestamp'

/** A default's presence and value, without exposing or executing a factory. */
export type StorageDefault =
  | { kind: 'absent' }
  | { kind: 'value'; value: unknown }
  | { kind: 'factory' }

/** Private semantic evidence consumed by storage decisions. No native schemas belong here. */
export interface StorageFacts {
  outputKind: StorageOutputKind | undefined
  /** Unconstrained output differs from an unsupported family or an unknown transformation. */
  outputState: 'known' | 'unconstrained' | 'unsupported' | 'unresolved'
  nullable: boolean
  allowsUndefined: boolean
  outputMayBeUndefined: boolean
  omitOnInsert: boolean
  schemaDefault: StorageDefault
  stringConstraints: Readonly<StringConstraints>
  stringFormats: readonly StorageStringFormat[]
  numberConstraints: Readonly<NumberConstraints>
  bigintConstraints: Readonly<{ minValue?: bigint; maxValue?: bigint }>
  /** A singleton assertion and a finite choice retain distinct storage policies. */
  finiteEvidence?: 'singleton' | 'choice'
  /**
   * Original singleton output, retained even if later validators narrow finiteValues
   * away.
   */
  singletonValue?: unknown
  finiteValues?: readonly unknown[]
  /** Original finite choices, before later validation narrows finiteValues. */
  finiteSourceValues?: readonly unknown[]
  composite?: {
    kind: 'alternatives' | 'intersection'
    branches: readonly StorageFacts[]
  }
  jsonShape?: 'object' | 'array' | 'mixed'
  jsonOutputCompatible?: boolean
  nullOnly: boolean
}
