import { describe, expectTypeOf, it } from 'vitest'

import type {
  CanonicalIdentifier,
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  LoweredDatabaseDefault,
  MigrationColumnReference,
  MigrationColumnTarget,
  MigrationIndexTarget,
  MigrationNamespaceTarget,
  MigrationPlan,
  MigrationRelationTarget,
  MigrationStep,
  MigrationTarget,
} from '@/index'

type ExpectedNamespaceTarget = Readonly<{
  kind: 'namespace'
  namespace: readonly CanonicalNamespaceSegment[]
}>

type ExpectedRelationTarget = Readonly<{
  kind: 'relation'
  relation: CanonicalRelationIdentity
}>

type ExpectedColumnTarget = Readonly<{
  kind: 'column'
  relation: CanonicalRelationIdentity
  column: CanonicalIdentifier
}>

type ExpectedIndexTarget = Readonly<{
  kind: 'index'
  relation: CanonicalRelationIdentity
  index: CanonicalIdentifier
}>

type ExpectedReference = Readonly<{
  relation: CanonicalRelationIdentity
  column: CanonicalIdentifier
  onDelete?: string
  onUpdate?: string
}>

type ExpectedMigrationStep =
  | Readonly<{ kind: 'ensure_namespace'; target: ExpectedNamespaceTarget }>
  | Readonly<{ kind: 'create_table'; target: ExpectedRelationTarget }>
  | Readonly<{
      kind: 'add_column'
      target: ExpectedColumnTarget
      dataType: string
      notNull: boolean
      unique?: boolean
      defaultValue?: string | number | boolean | null
      databaseDefault?: LoweredDatabaseDefault
      generated?: 'always' | 'byDefault'
      autoIncrement?: boolean
    }>
  | Readonly<{
      kind: 'alter_column_type'
      target: ExpectedColumnTarget
      dataType: string
    }>
  | Readonly<{
      kind: 'add_foreign_key'
      target: ExpectedColumnTarget
      references: ExpectedReference
    }>
  | Readonly<{ kind: 'add_unique_constraint'; target: ExpectedColumnTarget }>
  | Readonly<{ kind: 'set_not_null'; target: ExpectedColumnTarget }>
  | Readonly<{ kind: 'drop_not_null'; target: ExpectedColumnTarget }>
  | Readonly<{
      kind: 'create_index'
      target: ExpectedIndexTarget
      columns: readonly CanonicalIdentifier[]
      unique: boolean
    }>
  | Readonly<{ kind: 'drop_column'; target: ExpectedColumnTarget }>
  | Readonly<{ kind: 'drop_table'; target: ExpectedRelationTarget }>
  | Readonly<{ kind: 'drop_index'; target: ExpectedIndexTarget }>

describe('public Migration Plan types', () => {
  it('keeps the descriptive plan and step shapes exact', () => {
    expectTypeOf<MigrationPlan>().toEqualTypeOf<
      Readonly<{ steps: readonly MigrationStep[] }>
    >()
    expectTypeOf<MigrationStep>().toEqualTypeOf<ExpectedMigrationStep>()
    expectTypeOf<Extract<MigrationStep, { kind: 'create_table' }>>().toEqualTypeOf<
      Readonly<{ kind: 'create_table'; target: ExpectedRelationTarget }>
    >()
  })

  it('addresses every step through one exact structured target union', () => {
    expectTypeOf<MigrationNamespaceTarget>().toEqualTypeOf<ExpectedNamespaceTarget>()
    expectTypeOf<MigrationRelationTarget>().toEqualTypeOf<ExpectedRelationTarget>()
    expectTypeOf<MigrationColumnTarget>().toEqualTypeOf<ExpectedColumnTarget>()
    expectTypeOf<MigrationIndexTarget>().toEqualTypeOf<ExpectedIndexTarget>()
    expectTypeOf<MigrationColumnReference>().toEqualTypeOf<ExpectedReference>()
    expectTypeOf<MigrationTarget>().toEqualTypeOf<
      | ExpectedNamespaceTarget
      | ExpectedRelationTarget
      | ExpectedColumnTarget
      | ExpectedIndexTarget
    >()
    expectTypeOf<MigrationStep['target']>().toEqualTypeOf<MigrationTarget>()
  })
})
