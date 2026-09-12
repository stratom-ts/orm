import { describe, expect, it } from 'vitest'

import { lowerDesiredSchema } from '@/ddl/desiredSchema'
import type { MigrationSemanticProfile, PlannedMigration } from '@/ddl/migrationPlan'
import type { MigrationAtomicity, MigrationCapabilityIssue } from '@/ddl/migrationProgram'
import type {
  CatalogCapability,
  CatalogCoverage,
  CatalogExecutor,
  CatalogRequest,
} from '@/dialects/catalog'
import type { CompiledQuery, Dialect, SqlAst, SqlDataType } from '@/dialects/types'
import type {
  CanonicalRelationIdentity,
  NamespaceContext,
  NamespaceIdentifierInput,
  NamespaceRole,
} from '@/migrations/canonicalRelationIdentity'
import type { OperationSessionProvider } from '@/operations'
import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'

import type { DialectLifecycleContractFactory } from './dialectMemberContract'
import { registerDialectLifecycleContract } from './dialectMemberContract'
import type { CoordinationContractFactory } from './migrationCoordinationContract'
import { registerMigrationCoordinationContract } from './migrationCoordinationContract'
import type {
  ProviderContractFactory,
  ProviderMigrationContract,
} from './operationSessionProviderContract'
import { registerOperationSessionProviderContract } from './operationSessionProviderContract'

type ContractValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ContractValue[]
  | Readonly<{ [key: string]: ContractValue }>

type UnsupportedContract = Readonly<{ state: 'unsupported'; reason: string }>
type SupportedContract<T> = Readonly<{ state: 'supported'; input: T }>
type ContractSupport<T> = SupportedContract<T> | UnsupportedContract
type DialectContractFacet =
  | 'catalog'
  | 'coordination'
  | 'desired-schema'
  | 'identity'
  | 'lifecycle'
  | 'migration'
  | 'migration/unsupported-lowering'
  | 'naming'
  | 'operation-session/common'
  | 'operation-session/controlled'
  | 'query'
  | 'query/value-mapping'

type IdentityContractInput = Readonly<{
  dialect: Dialect
  context: NamespaceContext
  registrationDefault?: readonly NamespaceIdentifierInput[]
  relation: RelationIdentityInput
  expected: CanonicalRelationIdentity
}>

type NamingContractInput = Readonly<{
  dialect: Dialect
  owner: RelationIdentityInput
  context: NamespaceContext
  columns: readonly string[]
  expectedName: string
  collisionName: string
}>

type DesiredSchemaContractInput = Readonly<{
  dialect: Dialect
  context: NamespaceContext
  registrationDefault?: readonly NamespaceIdentifierInput[]
  handles: readonly TableHandle[]
  expected: readonly Readonly<{
    namespace: readonly Readonly<{ role: NamespaceRole; spelling: string }>[]
    relation: string
    columns: readonly Readonly<{ name: string; dataType: SqlDataType }>[]
    primaryKey: readonly string[]
  }>[]
}>

type QueryCoreContractInput = Readonly<{
  dialect: Dialect
  handles: readonly TableHandle[]
  target: TableHandle
  registrationDefault?: readonly NamespaceIdentifierInput[]
  relation: RelationIdentityInput
  column: string
  node: SqlAst
  inspectCompiled(query: CompiledQuery): ContractValue
  expected: Readonly<{
    relationMatches: readonly string[]
    columnMatches: readonly string[]
    compiled: ContractValue
  }>
}>

type QueryValueMappingContractInput = Readonly<{
  dialect: Dialect
  dataType: SqlDataType
  paramValue: ContractValue
  resultValue: ContractValue
  expected: Readonly<{
    mappedParam: ContractValue
    mappedResult: ContractValue
  }>
}>

type QueryContract = Readonly<{
  core: ContractSupport<QueryCoreContractInput>
  valueMapping: ContractSupport<QueryValueMappingContractInput>
}>

type CatalogCapabilityExpectations = Readonly<
  Record<'namespaces' | 'relationOwner' | 'identity' | 'richObjects', CatalogCapability>
>

type CatalogContractInput = Readonly<{
  dialect: Dialect
  executor: CatalogExecutor
  request: CatalogRequest
  expected: Readonly<{
    sourceDialect: string
    writableDefault: readonly NamespaceIdentifierInput[]
    namespaceCoverage: CatalogCoverage
    capabilities: CatalogCapabilityExpectations
  }>
}>

type OperationSessionContractEvent =
  | 'query'
  | 'run'
  | 'cancel'
  | 'release:reuse'
  | 'close'

type OperationSessionCommonRuntime = Readonly<{
  provider: OperationSessionProvider
  events(): readonly OperationSessionContractEvent[]
}>

type OperationSessionContract = Readonly<{
  common: ContractSupport<Readonly<{ createRuntime(): OperationSessionCommonRuntime }>>
  controlled: ContractSupport<
    Readonly<{
      createProvider: ProviderContractFactory
      migration?: ProviderMigrationContract
    }>
  >
}>

type MigrationContractCase = Readonly<{
  dialect: Dialect
  planned: PlannedMigration
  profile: MigrationSemanticProfile
  mismatchedProfiles: Readonly<
    Record<
      'identityAdapter' | 'namespaceContext' | 'registrationDefault',
      MigrationSemanticProfile
    >
  >
  expectedProgram: Readonly<{
    atomicity: MigrationAtomicity
    actionCount: number
    sourceStepIndexes: readonly (readonly number[])[]
  }>
}>

type MigrationContractInput = Readonly<{
  createCase(): MigrationContractCase | Promise<MigrationContractCase>
}>

type UnsupportedMigrationContractCase = Readonly<{
  dialect: Dialect
  planned: PlannedMigration
  profile: MigrationSemanticProfile
  issue: Readonly<{
    code: MigrationCapabilityIssue['code']
    message: string
    sourceStepIndexes: readonly number[]
  }>
}>

type UnsupportedMigrationContractInput = Readonly<{
  createCase():
    | UnsupportedMigrationContractCase
    | Promise<UnsupportedMigrationContractCase>
}>

type MigrationContract = Readonly<{
  lowering: MigrationContractInput
  unsupportedLowering: ContractSupport<UnsupportedMigrationContractInput>
}>

/** Test-only inputs for the fixed shared contracts of one complete Dialect member. */
export type DialectContractKit = Readonly<{
  name: string
  identity?: ContractSupport<IdentityContractInput>
  naming?: ContractSupport<NamingContractInput>
  desiredSchema?: ContractSupport<DesiredSchemaContractInput>
  query?: QueryContract
  catalog?: ContractSupport<CatalogContractInput>
  operationSession?: OperationSessionContract
  coordination?: ContractSupport<CoordinationContractFactory>
  migration?: ContractSupport<MigrationContract>
  lifecycle?: ContractSupport<DialectLifecycleContractFactory>
}>

function registerUnsupported(
  name: string,
  facet: DialectContractFacet,
  support: UnsupportedContract,
): void {
  describe(`${name} Dialect contract [${facet}]`, () => {
    it('scenario [declares unsupported behavior with a reason]', () => {
      expect(support.reason.length).toBeGreaterThan(0)
    })
  })
}

function registerIdentity(
  name: string,
  support?: ContractSupport<IdentityContractInput>,
) {
  if (!support) return

  if (support.state === 'unsupported') {
    registerUnsupported(name, 'identity', support)
    return
  }

  it(`${name} Dialect contract [identity] scenario [resolves canonical structured identity]`, () => {
    const input = support.input
    const actual = input.dialect.identity
      .create({
        context: input.context,
        ...(input.registrationDefault === undefined
          ? {}
          : { registrationDefault: input.registrationDefault }),
      })
      .resolve(input.relation)
    expect(actual).toEqual(input.expected)
  })
}

function registerNaming(name: string, support?: ContractSupport<NamingContractInput>) {
  if (!support) return

  if (support.state === 'unsupported') {
    registerUnsupported(name, 'naming', support)
    return
  }

  it(`${name} Dialect contract [naming] scenario [generates validates and collision-checks names]`, () => {
    const input = support.input
    const owner = input.dialect.identity
      .create({ context: input.context })
      .resolve(input.owner)
    const seed = { kind: 'index' as const, owner, columns: input.columns, unique: false }
    expect(input.dialect.naming.generate(seed)).toBe(input.expectedName)
    expect(() =>
      input.dialect.naming.validate(input.expectedName, 'contract index'),
    ).not.toThrow()
    const registry = input.dialect.naming.createRegistry()
    registry.reserve({
      kind: 'index',
      owner,
      name: input.collisionName,
      token: 'first',
      description: 'first contract index',
    })
    expect(() =>
      registry.reserve({
        kind: 'index',
        owner,
        name: input.collisionName,
        token: 'second',
        description: 'second contract index',
      }),
    ).toThrow(/collision/i)
  })
}

function registerDesiredSchema(
  name: string,
  support?: ContractSupport<DesiredSchemaContractInput>,
) {
  if (!support) return

  if (support.state === 'unsupported') {
    registerUnsupported(name, 'desired-schema', support)
    return
  }

  it(`${name} Dialect contract [desired-schema] scenario [lowers the complete authored graph]`, () => {
    const input = support.input
    const identities = input.dialect.identity.create({
      context: input.context,
      ...(input.registrationDefault === undefined
        ? {}
        : { registrationDefault: input.registrationDefault }),
    })
    const actual = lowerDesiredSchema(input.handles, identities, input.dialect.schema)
    expect(
      actual.tables.map((table) => ({
        namespace: table.identity.namespace.map((segment) => ({
          role: segment.role,
          spelling: segment.identifier.spelling,
        })),
        relation: table.identity.relation.spelling,
        columns: table.columns.map((column) => ({
          name: column.identifier.spelling,
          dataType: column.dataType,
        })),
        primaryKey: table.primaryKey.map((column) => column.spelling),
      })),
    ).toEqual(input.expected)
  })
}

function registerQuery(name: string, contract?: QueryContract) {
  if (!contract) return

  if (contract.core.state === 'unsupported') {
    registerUnsupported(name, 'query', contract.core)
  } else {
    const input = contract.core.input
    it(`${name} Dialect contract [query] scenario [agrees across lookup and compilation]`, () => {
      const resolved = input.dialect.query.resolve(input.handles, {
        ...(input.registrationDefault === undefined
          ? {}
          : { registrationDefault: input.registrationDefault }),
      })
      expect({
        relationMatches: resolved
          .findRelationMatches(input.relation)
          .map((handle) => handle.getTableMetadata().relation.relation),
        columnMatches: resolved.findColumnMatches(input.target, input.column),
        compiled: input.inspectCompiled(resolved.compile(input.node)),
      }).toEqual(input.expected)
    })
  }

  if (contract.valueMapping.state === 'unsupported') {
    registerUnsupported(name, 'query/value-mapping', contract.valueMapping)
  } else {
    const input = contract.valueMapping.input
    it(`${name} Dialect contract [query] scenario [maps parameter and result values]`, () => {
      const mapParam = input.dialect.query.mapParamValue
      const mapResult = input.dialect.query.mapResultValue
      expect(mapParam).toBeTypeOf('function')
      expect(mapResult).toBeTypeOf('function')

      if (!mapParam || !mapResult) {
        throw new Error(
          'The adapter declared value mapping without both mapping functions',
        )
      }

      expect({
        mappedParam: mapParam(input.dataType, input.paramValue),
        mappedResult: mapResult(input.dataType, input.resultValue),
      }).toEqual(input.expected)
    })
  }
}

function registerCatalog(name: string, support?: ContractSupport<CatalogContractInput>) {
  if (!support) return

  if (support.state === 'unsupported') {
    registerUnsupported(name, 'catalog', support)
    return
  }

  it(`${name} Dialect contract [catalog] scenario [returns explicit evidence and capabilities]`, async () => {
    const input = support.input
    const snapshot = await input.dialect.catalog.introspectCatalog(
      input.executor,
      input.request,
    )
    expect(snapshot.source.dialect).toBe(input.expected.sourceDialect)
    expect(snapshot.namespaceContext.writableDefault).toEqual(
      input.expected.writableDefault,
    )
    expect(snapshot.namespaces.coverage).toEqual(input.expected.namespaceCoverage)
    expect({
      namespaces: snapshot.capabilities.namespaces,
      relationOwner: snapshot.capabilities.relationOwner,
      identity: snapshot.capabilities.identity,
      richObjects: snapshot.capabilities.richObjects,
    }).toEqual(input.expected.capabilities)
  })
}

function registerOperationSession(name: string, contract?: OperationSessionContract) {
  if (!contract) return

  if (contract.common.state === 'unsupported') {
    registerUnsupported(name, 'operation-session/common', contract.common)
  } else {
    const common = contract.common.input
    it(`${name} Dialect contract [operation-session] scenario [provides a semantic session lifecycle]`, async () => {
      const runtime = common.createRuntime()
      const provider = runtime.provider
      const session = await provider.open()
      expect(session.identity.database.length).toBeGreaterThan(0)
      expect(session.identity.physicalSession.length).toBeGreaterThan(0)
      await session.query({ sql: 'contract query', params: [] })
      await session.run({ sql: 'contract run', params: [] })
      await session.cancel()
      await session.release('reuse')
      await provider.close()
      expect(runtime.events()).toEqual([
        'query',
        'run',
        'cancel',
        'release:reuse',
        'close',
      ])
    })
  }

  if (contract.controlled.state === 'unsupported') {
    registerUnsupported(name, 'operation-session/controlled', contract.controlled)
  } else {
    registerOperationSessionProviderContract(
      name,
      contract.controlled.input.createProvider,
      contract.controlled.input.migration,
    )
  }
}

function registerCoordination(
  name: string,
  support?: ContractSupport<CoordinationContractFactory>,
) {
  if (!support) return

  if (support.state === 'unsupported') {
    registerUnsupported(name, 'coordination', support)
    return
  }

  registerMigrationCoordinationContract(name, support.input)
}

function registerMigration(name: string, support?: ContractSupport<MigrationContract>) {
  if (!support) return

  if (support.state === 'unsupported') {
    registerUnsupported(name, 'migration', support)
    return
  }

  describe(`${name} Dialect contract [migration]`, () => {
    it('scenario [lowers one complete program and validates every Semantic Profile field]', async () => {
      const input = await support.input.lowering.createCase()
      const lowered = input.dialect.migration.lower(input.planned, input.profile)
      expect({
        atomicity: lowered.program?.atomicity,
        actionCount: lowered.program?.actions.length,
        sourceStepIndexes: lowered.program?.actions.map(
          (action) => action.sourceStepIndexes,
        ),
      }).toEqual(input.expectedProgram)

      for (const [field, profile] of Object.entries(input.mismatchedProfiles)) {
        const mismatch = input.dialect.migration.lower(input.planned, profile)
        expect(mismatch.program, field).toBeUndefined()
        expect(mismatch.issues, field).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'profile_mismatch', sourceStepIndexes: [] }),
          ]),
        )
      }
    })

    if (support.input.unsupportedLowering.state === 'unsupported') {
      registerUnsupported(
        name,
        'migration/unsupported-lowering',
        support.input.unsupportedLowering,
      )
    } else {
      const unsupported = support.input.unsupportedLowering.input
      it('scenario [returns unsupported issues without a partial program]', async () => {
        const input = await unsupported.createCase()
        const lowered = input.dialect.migration.lower(input.planned, input.profile)
        expect(lowered.program).toBeUndefined()
        expect(lowered.issues).toEqual([input.issue])
      })
    }
  })
}

function registerLifecycle(
  name: string,
  support?: ContractSupport<DialectLifecycleContractFactory>,
) {
  if (!support) return

  if (support.state === 'unsupported') {
    registerUnsupported(name, 'lifecycle', support)
    return
  }

  registerDialectLifecycleContract(name, support.input)
}

/** Registers the fixed shared scenarios for the supplied Dialect facets. */
export function registerDialectContractKit(contract: DialectContractKit): void {
  registerIdentity(contract.name, contract.identity)
  registerNaming(contract.name, contract.naming)
  registerDesiredSchema(contract.name, contract.desiredSchema)
  registerQuery(contract.name, contract.query)
  registerCatalog(contract.name, contract.catalog)
  registerOperationSession(contract.name, contract.operationSession)
  registerCoordination(contract.name, contract.coordination)
  registerMigration(contract.name, contract.migration)
  registerLifecycle(contract.name, contract.lifecycle)
}
