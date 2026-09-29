import { describe, expect, it } from 'vitest'

import { lowerDesiredSchema } from '@/ddl/desiredSchema'
import type { MigrationSemanticProfile, PlannedMigration } from '@/ddl/migrationPlan'
import type { MigrationCapabilityIssue, MigrationProgram } from '@/ddl/migrationProgram'
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
import type { OperationSession, OperationSessionProvider } from '@/operations'
import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { attempt } from '@/utils/error'

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
  | 'operation-session'
  | 'operation-session/common'
  | 'operation-session/controlled'
  | 'query'
  | 'query/value-mapping'

const dialectMemberFacets = [
  'identity',
  'naming',
  'desiredSchema',
  'query',
  'catalog',
  'operationSession',
  'coordination',
  'migration',
  'lifecycle',
] as const

type DialectMemberFacet = (typeof dialectMemberFacets)[number]

type DialectMemberCapability<TShard extends string> =
  | Readonly<{ state: 'supported'; shard: TShard }>
  | Readonly<{ state: 'unsupported'; reason: string; shard: TShard }>

/** Exhaustive test-only capability declaration for one complete Dialect member. */
export type DialectContractMemberCapabilities<TShard extends string = string> = Readonly<
  Record<DialectMemberFacet, DialectMemberCapability<TShard>>
>

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

const queryCompilerScenarioIds = [
  'select.projection',
  'select.namespace',
  'select.join.inner',
  'select.join.left',
  'select.join.right',
  'predicate.comparisons',
  'predicate.boolean',
  'predicate.null',
  'expression.scalar',
  'expression.aggregate',
  'clause.group-having-order',
  'clause.pagination',
  'insert.rows-defaults-returning',
  'update.set-where-returning',
  'delete.where-returning',
] as const

type QueryCompilerScenarioId = (typeof queryCompilerScenarioIds)[number]

type QueryCompilerScenarioInput = Readonly<{
  dialect: Dialect
  handles: readonly TableHandle[]
  registrationDefault?: readonly NamespaceIdentifierInput[]
  node: SqlAst
  expected: Readonly<{ sql: string; params: readonly unknown[] }>
}>

type QueryCompilerScenario = Readonly<{
  support:
    | SupportedContract<QueryCompilerScenarioInput>
    | Readonly<{
        state: 'unsupported'
        reason: string
        input: Omit<QueryCompilerScenarioInput, 'expected'>
        expectedMessage: string
      }>
}>

export type QueryCompilerScenarios = Readonly<
  Record<QueryCompilerScenarioId, QueryCompilerScenario>
>

function resolveCompiler(
  input: Pick<QueryCompilerScenarioInput, 'dialect' | 'handles' | 'registrationDefault'>,
) {
  return input.dialect.query.resolve(input.handles, {
    ...(input.registrationDefault === undefined
      ? {}
      : { registrationDefault: input.registrationDefault }),
  })
}

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
  state: 'supported'
  core: ContractSupport<QueryCoreContractInput>
  scenarios: QueryCompilerScenarios
  valueMapping: ContractSupport<QueryValueMappingContractInput>
}>

type CatalogCapabilityExpectations = Readonly<
  Record<'namespaces' | 'relationOwner' | 'identity' | 'richObjects', CatalogCapability>
>

type CatalogNamespaceEvidence = readonly Readonly<{
  role: NamespaceRole
  spelling: string
}>[]

type CatalogRelationEvidence = Readonly<{
  namespace: CatalogNamespaceEvidence
  relation: string
}>

type CatalogRequestEvidence = Readonly<{
  relations: readonly Readonly<{
    identity: CatalogRelationEvidence
    shape: 'complete' | 'additive'
  }>[]
  absentRelations: readonly CatalogRelationEvidence[]
  completeNamespaces: readonly CatalogNamespaceEvidence[]
}>

export type CatalogContractInput = Readonly<{
  dialect: Dialect
  executor: CatalogExecutor
  request: CatalogRequest
  expected: Readonly<{
    sourceDialect: string
    writableDefault: readonly NamespaceIdentifierInput[]
    namespaceCoverage: CatalogCoverage
    capabilities: CatalogCapabilityExpectations
    request: CatalogRequestEvidence
    namespaces: readonly Readonly<{
      identity: CatalogNamespaceEvidence
      relationCoverage: CatalogCoverage
      relations: readonly CatalogRelationEvidence[]
    }>[]
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

/** Runs the shared operation-session lifecycle with failure-safe cleanup. */
export async function runOperationSessionCommonContract(
  runtime: OperationSessionCommonRuntime,
): Promise<void> {
  const provider = runtime.provider
  let session: OperationSession | undefined
  let completed = false
  let cleanupError: unknown
  let hasCleanupError = false

  try {
    session = await provider.open()
    expect(session.identity.database.length).toBeGreaterThan(0)
    expect(session.identity.physicalSession.length).toBeGreaterThan(0)
    await session.query({ sql: 'contract query', params: [] })
    await session.run({ sql: 'contract run', params: [] })
    await session.cancel()
    completed = true
  } finally {
    const release = session
      ? await attempt(() => session!.release(completed ? 'reuse' : 'discard'))
      : undefined
    const close = await attempt(() => provider.close())

    if (release && !release.ok) {
      cleanupError = release.error
      hasCleanupError = true
    } else if (!close.ok) {
      cleanupError = close.error
      hasCleanupError = true
    }
  }

  if (hasCleanupError) throw cleanupError

  expect(runtime.events()).toEqual(['query', 'run', 'cancel', 'release:reuse', 'close'])
}

type OperationSessionContract = Readonly<{
  state: 'supported'
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
      Readonly<{
        profile: MigrationSemanticProfile
        issues: readonly MigrationCapabilityIssue[]
      }>
    >
  >
  expectedProgram: MigrationProgram
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

type FacetContractInput = Readonly<{
  identity: ContractSupport<IdentityContractInput>
  naming: ContractSupport<NamingContractInput>
  desiredSchema: ContractSupport<DesiredSchemaContractInput>
  query: QueryContract | UnsupportedContract
  catalog: ContractSupport<CatalogContractInput>
  operationSession: OperationSessionContract | UnsupportedContract
  coordination: ContractSupport<CoordinationContractFactory>
  migration: ContractSupport<MigrationContract>
  lifecycle: ContractSupport<DialectLifecycleContractFactory>
}>

type MemberShard<TCapabilities extends DialectContractMemberCapabilities> =
  TCapabilities[DialectMemberFacet]['shard']

type OwnedFacet<
  TCapabilities extends DialectContractMemberCapabilities,
  TShard extends MemberShard<TCapabilities>,
> = {
  [TFacet in DialectMemberFacet]: TCapabilities[TFacet]['shard'] extends TShard
    ? TFacet
    : never
}[DialectMemberFacet]

type CompatibleFacetInput<
  TCapabilities extends DialectContractMemberCapabilities,
  TFacet extends DialectMemberFacet,
> = TCapabilities[TFacet]['state'] extends 'supported'
  ? TFacet extends 'query'
    ? QueryContract
    : TFacet extends 'operationSession'
      ? OperationSessionContract
      : Extract<FacetContractInput[TFacet], { state: 'supported' }>
  : UnsupportedContract

type ShardFacetInputs<
  TCapabilities extends DialectContractMemberCapabilities,
  TShard extends MemberShard<TCapabilities>,
> = {
  [TFacet in OwnedFacet<TCapabilities, TShard>]-?: CompatibleFacetInput<
    TCapabilities,
    TFacet
  >
} & {
  [TFacet in Exclude<DialectMemberFacet, OwnedFacet<TCapabilities, TShard>>]?: never
}

type DialectContractShard<
  TCapabilities extends DialectContractMemberCapabilities,
  TShard extends MemberShard<TCapabilities>,
> = ShardFacetInputs<TCapabilities, TShard>

type DialectContractMemberRegistrations<
  TCapabilities extends DialectContractMemberCapabilities,
> = Readonly<{
  [TShard in MemberShard<TCapabilities>]: DialectContractShard<TCapabilities, TShard>
}>

/** Registers each declared member shard exactly once at one test entry point. */
export function registerDialectContractMember<
  const TCapabilities extends DialectContractMemberCapabilities,
>(
  name: string,
  capabilities: TCapabilities,
  registrations: DialectContractMemberRegistrations<TCapabilities>,
): void {
  validateDialectContractMember(capabilities)
  const declared = new Set(dialectMemberFacets.map((facet) => capabilities[facet].shard))
  for (const shard of declared) {
    if (!Object.hasOwn(registrations, shard))
      throw new Error(`Dialect contract member omits declared shard ${shard}`)
  }

  for (const shard of Object.keys(registrations)) {
    if (!declared.has(shard))
      throw new Error(`Dialect contract member registers unknown shard ${shard}`)
  }

  for (const shard of declared) {
    validateDialectContractShard(
      capabilities,
      shard,
      registrations[shard as MemberShard<TCapabilities>],
    )
  }

  for (const shard of declared) {
    registerDialectContractShard(
      name,
      capabilities,
      shard,
      registrations[shard as MemberShard<TCapabilities>],
    )
  }
}

/** Validates an exhaustive test-only declaration before any scenarios register. */
function validateDialectContractMember<
  TCapabilities extends DialectContractMemberCapabilities,
>(capabilities: TCapabilities): void {
  for (const facet of dialectMemberFacets) {
    const capability = (capabilities as Partial<Record<DialectMemberFacet, unknown>>)[
      facet
    ]

    if (typeof capability !== 'object' || capability === null) {
      throw new Error(`Dialect contract capability declaration omits ${facet}`)
    }

    const candidate = capability as {
      state?: unknown
      shard?: unknown
      reason?: unknown
    }

    if (candidate.state !== 'supported' && candidate.state !== 'unsupported') {
      throw new Error(`Dialect contract capability ${facet} has an invalid state`)
    }

    if (typeof candidate.shard !== 'string' || candidate.shard.trim().length === 0) {
      throw new Error(`Dialect contract capability ${facet} needs a non-empty shard`)
    }

    if (
      candidate.state === 'unsupported' &&
      (typeof candidate.reason !== 'string' || candidate.reason.trim().length === 0)
    ) {
      throw new Error(`Dialect contract capability ${facet} needs a non-empty reason`)
    }
  }
}

/** Validates that one isolated registration supplies all and only its owned facets. */
function validateDialectContractShard(
  capabilities: DialectContractMemberCapabilities,
  shard: string,
  inputs: object,
): void {
  for (const facet of dialectMemberFacets) {
    const owned = capabilities[facet].shard === shard
    const input = (inputs as Partial<Record<DialectMemberFacet, unknown>>)[facet]

    if (owned && input === undefined) {
      throw new Error(`Dialect contract shard ${shard} omits its ${facet} input`)
    }

    if (!owned && input !== undefined) {
      throw new Error(`Dialect contract shard ${shard} does not own ${facet}`)
    }

    if (
      owned &&
      typeof input === 'object' &&
      input !== null &&
      'state' in input &&
      input.state !== capabilities[facet].state
    ) {
      throw new Error(`Dialect contract shard ${shard} disagrees about ${facet}`)
    }
  }
}

function registerUnsupported(
  name: string,
  facet: DialectContractFacet,
  support: UnsupportedContract,
): void {
  describe(`${name} Dialect contract [${facet}]`, () => {
    it('scenario [declares unsupported behavior with a reason]', () => {
      expect(support.reason.trim().length).toBeGreaterThan(0)
    })
  })
}

function registerIdentity(name: string, support: ContractSupport<IdentityContractInput>) {
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

function registerNaming(name: string, support: ContractSupport<NamingContractInput>) {
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
  support: ContractSupport<DesiredSchemaContractInput>,
) {
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

function registerQuery(name: string, contract: QueryContract | UnsupportedContract) {
  if (contract.state === 'unsupported') {
    registerUnsupported(name, 'query', contract)
    return
  }

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

  for (const scenarioId of queryCompilerScenarioIds) {
    const scenario = contract.scenarios[scenarioId]
    const support = scenario.support

    if (support.state === 'unsupported') {
      it(`${name} [query/compiler] scenario [${scenarioId}] declares unsupported behavior and fails before execution`, () => {
        expect(support.reason.trim().length).toBeGreaterThan(0)
        expect(support.expectedMessage.trim().length).toBeGreaterThan(0)
        // Resolve the compiler directly. No connector or executor is involved
        // in this contract, so unsupported AST forms fail before database work.

        const input = support.input
        expect(() => resolveCompiler(input).compile(input.node)).toThrow(
          support.expectedMessage,
        )
      })

      continue
    }

    const input = support.input
    it(`${name} [query/compiler] scenario [${scenarioId}]`, () => {
      const compiled = resolveCompiler(input).compile(input.node)
      expect({ sql: compiled.sql, params: compiled.params }).toEqual({
        sql: input.expected.sql,
        params: input.expected.params,
      })
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

function namespaceEvidence(
  namespace: readonly Readonly<{
    role: NamespaceRole
    identifier: Readonly<{ spelling: string }>
  }>[],
): CatalogNamespaceEvidence {
  return namespace.map((segment) => ({
    role: segment.role,
    spelling: segment.identifier.spelling,
  }))
}

function relationEvidence(identity: CanonicalRelationIdentity): CatalogRelationEvidence {
  return {
    namespace: namespaceEvidence(identity.namespace),
    relation: identity.relation.spelling,
  }
}

/** Runs the shared catalog assertions through the same seam used by registrations. */
export async function runCatalogContract(input: CatalogContractInput): Promise<void> {
  const snapshot = await input.dialect.catalog.introspectCatalog(
    input.executor,
    input.request,
  )
  expect({
    sourceDialect: snapshot.source.dialect,
    writableDefault: snapshot.namespaceContext.writableDefault,
    namespaceCoverage: snapshot.namespaces.coverage,
    capabilities: {
      namespaces: snapshot.capabilities.namespaces,
      relationOwner: snapshot.capabilities.relationOwner,
      identity: snapshot.capabilities.identity,
      richObjects: snapshot.capabilities.richObjects,
    },
    request: {
      relations: snapshot.request.relations.map(({ identity, shape }) => ({
        identity: relationEvidence(identity),
        shape,
      })),
      absentRelations: snapshot.request.absentRelations.map(relationEvidence),
      completeNamespaces: snapshot.request.completeNamespaces.map(namespaceEvidence),
    },
    namespaces: snapshot.namespaces.items.map((namespace) => ({
      identity: namespaceEvidence(namespace.identity),
      relationCoverage: namespace.relations.coverage,
      relations: namespace.relations.items.map((relation) =>
        relationEvidence(relation.identity),
      ),
    })),
  }).toEqual(input.expected)
}

function registerCatalog(name: string, support: ContractSupport<CatalogContractInput>) {
  if (support.state === 'unsupported') {
    registerUnsupported(name, 'catalog', support)
    return
  }

  it(`${name} Dialect contract [catalog] scenario [returns explicit evidence and capabilities]`, async () => {
    await runCatalogContract(support.input)
  })
}

function registerOperationSession(
  name: string,
  contract: OperationSessionContract | UnsupportedContract,
) {
  if (contract.state === 'unsupported') {
    registerUnsupported(name, 'operation-session', contract)
    return
  }

  if (contract.common.state === 'unsupported') {
    registerUnsupported(name, 'operation-session/common', contract.common)
  } else {
    const common = contract.common.input
    it(`${name} Dialect contract [operation-session] scenario [provides a semantic session lifecycle]`, async () => {
      await runOperationSessionCommonContract(common.createRuntime())
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
  support: ContractSupport<CoordinationContractFactory>,
) {
  if (support.state === 'unsupported') {
    registerUnsupported(name, 'coordination', support)
    return
  }

  registerMigrationCoordinationContract(name, support.input)
}

function registerMigration(name: string, support: ContractSupport<MigrationContract>) {
  if (support.state === 'unsupported') {
    registerUnsupported(name, 'migration', support)
    return
  }

  describe(`${name} Dialect contract [migration]`, () => {
    it('scenario [lowers one complete program and validates every Semantic Profile field]', async () => {
      const input = await support.input.lowering.createCase()
      const lowered = input.dialect.migration.lower(input.planned, input.profile)
      expect(lowered.program).toEqual(input.expectedProgram)

      for (const [field, mismatchCase] of Object.entries(input.mismatchedProfiles)) {
        const mismatch = input.dialect.migration.lower(
          input.planned,
          mismatchCase.profile,
        )
        expect(mismatch.program, field).toBeUndefined()
        expect(mismatch.issues, field).toEqual(mismatchCase.issues)
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
  support: ContractSupport<DialectLifecycleContractFactory>,
) {
  if (support.state === 'unsupported') {
    registerUnsupported(name, 'lifecycle', support)
    return
  }

  registerDialectLifecycleContract(name, support.input)
}

function registerDialectContractShard(
  name: string,
  capabilities: DialectContractMemberCapabilities,
  shard: string,
  registration: Partial<FacetContractInput>,
): void {
  const inputs = registration as FacetContractInput

  if (capabilities.identity.shard === shard) registerIdentity(name, inputs.identity)
  if (capabilities.naming.shard === shard) registerNaming(name, inputs.naming)

  if (capabilities.desiredSchema.shard === shard)
    registerDesiredSchema(name, inputs.desiredSchema)

  if (capabilities.query.shard === shard) registerQuery(name, inputs.query)
  if (capabilities.catalog.shard === shard) registerCatalog(name, inputs.catalog)

  if (capabilities.operationSession.shard === shard)
    registerOperationSession(name, inputs.operationSession)

  if (capabilities.coordination.shard === shard)
    registerCoordination(name, inputs.coordination)

  if (capabilities.migration.shard === shard) registerMigration(name, inputs.migration)
  if (capabilities.lifecycle.shard === shard) registerLifecycle(name, inputs.lifecycle)
}
