import ts from '@typescript/typescript6'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const classifiesConcreteDialectReferenceSData = [
  ["import type { Dialect } from '@/dialects'", false],
  ["import type DefaultDialect from '@/dialects'", false],
  ["import { resolveDialect } from '@/dialects'", false],
  ["import { resolveDialect as resolve } from '@/dialects'", false],
  ["export { resolveDialect } from '@/dialects'", false],
  ["export { resolveDialect as resolve } from '@/dialects'", false],
  ["export type { Dialect } from '@/dialects'", false],
  ["import { postgresDialect } from '@/dialects'", true],
  ["import { oracleDialect } from '@/dialects'", true],
  ["import { postgresDialect as selected } from '@/dialects'", true],
  ["import { createDb0PostgresOperationSessionProvider } from '@/dialects'", true],
  ["export { sqliteDialect } from '@/dialects'", true],
  ["export { mssqlDialect } from '@/dialects'", true],
  ["import { resolveDialect, oracleDialect } from '@/dialects'", true],
  ["export { resolveDialect, mssqlDialect } from '@/dialects'", true],
  ["import defaultDialect from '@/dialects'", true],
  ["import * as dialects from '@/dialects'", true],
  ["import '@/dialects'", true],
  ["export * from '@/dialects'", true],
  ["export * as dialects from '@/dialects'", true],
  ["import { member } from '@/dialects/postgres'", true],
  ["const member = import('@/dialects/postgres')", true],
  ["const members = import('@/dialects')", true],
] as const

const classifiesSComparisonData = [
  [
    'canonical arrays',
    "arraysEqual(memberKeys('column', current.columns, identities), desired.primaryKey.map((column) => column.comparisonKey))",
    false,
  ],
  ['raw arrays', 'arraysEqual(current.columns, desired.primaryKey)', true],
  ['canonical map key', 'liveColumns.get(desired.identifier.comparisonKey)', false],
  ['raw map key', 'liveColumns.get(desired.name)', true],
  [
    'canonical set construction',
    'const desiredColumnNames = new Set(createAst.columns.map((column) => column.identifier.comparisonKey))',
    false,
  ],
  [
    'raw set construction',
    'const desiredColumnNames = new Set(createAst.columns.map((column) => column.name))',
    true,
  ],
  [
    'canonical member order',
    'compareCodeUnits(left.name.comparisonKey, right.name.comparisonKey)',
    false,
  ],
  ['raw member order', 'compareCodeUnits(left.name, right.name)', true],
] as const

const ROOT = process.cwd()
const CORE_PATHS = [
  'src/client.ts',
  'src/defineTable.ts',
  'src/ddl',
  'src/migrations',
  'src/operations',
  'src/query',
  'src/schemas',
]

const SHARED_EXECUTION_PATHS = [
  'src/query',
  'src/ddl',
  'src/migrations',
  'src/operations',
]

/**
 * Recursively collects TypeScript source paths for architecture checks.
 *
 * @param path - Repository-relative file or directory to inspect recursively.
 *
 * @returns TypeScript file paths collected recursively from the requested location.
 */
function sourceFiles(path: string): string[] {
  const absolute = join(ROOT, path)

  if (absolute.endsWith('.ts')) return [absolute]

  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name)
    return entry.isDirectory()
      ? sourceFiles(relative(ROOT, child))
      : entry.name.endsWith('.ts')
        ? [child]
        : []
  })
}

const coreFiles = CORE_PATHS.flatMap(sourceFiles)
const sharedExecutionFiles = SHARED_EXECUTION_PATHS.flatMap(sourceFiles)
const DIALECT_BARREL_RUNTIME_ALLOWLIST = new Set(['resolveDialect'])
const REQUIRED_DIALECT_FILES = [
  'dialect.ts',
  'index.ts',
  'identity.ts',
  'naming.ts',
  'schema.ts',
  'query.ts',
  'catalog.ts',
  'operations.ts',
  'operationSession.ts',
  'migration/index.ts',
] as const

const REQUIRED_DIALECT_FACETS = [
  'identity',
  'naming',
  'schema',
  'query',
  'catalog',
  'operations',
] as const

type PublicDialectContract = {
  provider: string
}

const PUBLIC_DIALECT_CONTRACTS = {
  postgres: {
    provider: 'createDb0PostgresOperationSessionProvider',
  },
  sqlite: {
    provider: 'createDb0NodeSqliteOperationSessionProvider',
  },
} as const satisfies Readonly<Record<string, PublicDialectContract>>

type ProductionDialectSource = {
  symbol: string
  code: string
  directory: string
}

type ImportBinding = {
  imported: string
  module: string
}

type IndexSurface = ReadonlyMap<string, ReadonlySet<string>>

/** Parses source into a TypeScript syntax tree for architecture checks. */
function parseSource(text: string, file = 'architecture-fixture.ts'): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** Parses source into a TypeScript syntax tree for architecture checks. */
function parse(file: string): ts.SourceFile {
  return parseSource(readFileSync(file, 'utf8'), file)
}

/** Maps each local named import to its original symbol and source module. */
function namedImportBindings(source: ts.SourceFile): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>()

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue

    const bindings = statement.importClause?.namedBindings

    if (!bindings || !ts.isNamedImports(bindings)) continue

    for (const element of bindings.elements) {
      imports.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        module: statement.moduleSpecifier.text,
      })
    }
  }

  return imports
}

/** Derives production dialect source directories from the resolver registration. */
function productionDialectSources(
  source = parse(join(ROOT, 'src/dialects/resolve.ts')),
): ProductionDialectSource[] {
  const imports = namedImportBindings(source)

  const declaration = descendants(source).find(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'productionDialects',
  )

  const members =
    declaration && descendants(declaration).find(ts.isArrayLiteralExpression)

  if (!members) throw new Error('productionDialects must be an array literal')

  return members.elements.map((element) => {
    if (!ts.isIdentifier(element))
      throw new Error('productionDialects entries must be imported identifiers')

    const binding = imports.get(element.text)
    const module = binding?.module

    if (!binding || !module?.startsWith('./') || module.slice(2).includes('/'))
      throw new Error(`${element.text} must be imported from a dialect directory`)

    const code = module.slice(2)
    const symbol = `${code}Dialect`

    if (element.text !== symbol || binding.imported !== symbol)
      throw new Error(`${module} must register an unaliased ${symbol} import`)

    return {
      symbol,
      code,
      directory: join(ROOT, 'src/dialects', code),
    }
  })
}

/** Returns runtime names declared by one exported source statement. */
function exportedStatementNames(statement: ts.Statement): string[] {
  const exported =
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)

  if (!exported) return []

  if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text]

  if (!ts.isVariableStatement(statement)) return []

  return statement.declarationList.declarations.flatMap(({ name }) =>
    ts.isIdentifier(name) ? [name.text] : [],
  )
}

/** Finds the sole exported defineDialect object in a member manifest. */
function dialectAssembly(
  source: ts.SourceFile,
  symbol: string,
): ts.ObjectLiteralExpression | undefined {
  const declarations = source.statements.filter(
    (statement) => !ts.isImportDeclaration(statement),
  )

  if (declarations.length !== 1 || !ts.isVariableStatement(declarations[0]!))
    return undefined

  const statement = declarations[0]
  const declarationsList = statement.declarationList

  if (
    declarationsList.declarations.length !== 1 ||
    !(declarationsList.flags & ts.NodeFlags.Const)
  )
    return undefined

  const [member] = statement.declarationList.declarations
  const call = member.initializer
  const exported = statement.modifiers?.some(
    ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
  )

  if (!exported || !ts.isIdentifier(member.name) || member.name.text !== symbol)
    return undefined

  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.expression.getText() !== 'defineDialect'
  )
    return undefined

  if (call.arguments.length !== 1) return undefined

  const definition = call.arguments[0]!
  return ts.isObjectLiteralExpression(definition) ? definition : undefined
}

/** Reports facet bindings that do not use the member's required imported modules. */
function dialectManifestViolations(
  source: ts.SourceFile,
  member: Pick<ProductionDialectSource, 'symbol' | 'code'>,
): string[] {
  const imports = namedImportBindings(source)
  const assembly = dialectAssembly(source, member.symbol)

  if (!assembly) return [`${member.symbol}: invalid defineDialect assembly`]

  const codePrefix = `${member.code[0]!.toUpperCase()}${member.code.slice(1)}`
  const defineDialect = imports.get('defineDialect')
  const violations =
    defineDialect?.imported === 'defineDialect' &&
    defineDialect.module === '../defineDialect'
      ? []
      : [`${member.symbol}: defineDialect must come from ../defineDialect`]

  const expected: { property: string; identifier: string; module: string }[] = [
    ...REQUIRED_DIALECT_FACETS.map((facet) => ({
      property: facet,
      identifier: `${member.code}${facet[0]!.toUpperCase()}${facet.slice(1)}`,
      module: `./${facet}`,
    })),
    {
      property: 'lower',
      identifier: `lower${codePrefix}MigrationPlan`,
      module: './migration',
    },
    {
      property: 'execute',
      identifier: `execute${codePrefix}Migration`,
      module: './migration',
    },
  ]

  return violations.concat(
    expected.flatMap(({ property, identifier, module }) => {
      const assignment = assembly.properties.find(
        (candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === property,
      )

      const binding = imports.get(identifier)
      const valid =
        assignment &&
        ts.isIdentifier(assignment.initializer) &&
        assignment.initializer.text === identifier &&
        binding?.imported === identifier &&
        binding.module === module

      return valid
        ? []
        : [`${member.symbol}: ${property} must use ${identifier} from ${module}`]
    }),
  )
}

/** Checks the imported session provider selected by a member's operations facet. */
function assertOperationSessionProvider(
  source: ts.SourceFile,
  code: string,
  expectedProvider: string,
): void {
  const declaration = descendants(source).find(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === `${code}Operations`,
  )

  const initializer = declaration?.initializer

  if (!initializer || !ts.isObjectLiteralExpression(initializer))
    throw new Error(`${code}Operations must be an object literal`)

  const provider = initializer.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === 'createSessionProvider',
  )

  if (!provider || !ts.isIdentifier(provider.initializer))
    throw new Error(`${code}Operations must select a session-provider identifier`)

  const providerName = provider.initializer.text
  const binding = namedImportBindings(source).get(providerName)

  if (providerName !== expectedProvider)
    throw new Error(`${code}Operations must use ${expectedProvider}`)

  if (binding?.imported !== providerName || binding.module !== './operationSession')
    throw new Error(
      `${code}Operations session provider must be an unaliased import from ./operationSession`,
    )
}

/** Derives one member's allowed public index surface from its documented declarations. */
function dialectIndexSurface(member: ProductionDialectSource): IndexSurface {
  if (!(member.code in PUBLIC_DIALECT_CONTRACTS))
    throw new Error(`${member.code} must declare its public contract`)

  const contract: PublicDialectContract =
    PUBLIC_DIALECT_CONTRACTS[member.code as keyof typeof PUBLIC_DIALECT_CONTRACTS]

  assertOperationSessionProvider(
    parse(join(member.directory, 'operations.ts')),
    member.code,
    contract.provider,
  )

  return new Map<string, ReadonlySet<string>>([
    ['./dialect', new Set([member.symbol])],
    ['./operationSession', new Set([contract.provider])],
  ])
}

/** Reports statements that deviate from one member's exact explicit export surface. */
function dialectIndexViolations(source: ts.SourceFile, expected: IndexSurface): string[] {
  const seen = new Set<string>()
  const violations = source.statements.flatMap((statement) =>
    inspectIndexExport(statement, expected, seen),
  )

  const missing = [...expected].flatMap(([module, names]) =>
    [...names].flatMap((name) =>
      seen.has(`${module}:${name}`) ? [] : [`missing public export ${name}`],
    ),
  )

  return [...violations, ...missing]
}

/** Checks one public index statement and records its valid named exports. */
function inspectIndexExport(
  statement: ts.Statement,
  expected: IndexSurface,
  seen: Set<string>,
): string[] {
  if (!ts.isExportDeclaration(statement) || statement.isTypeOnly)
    return ['index.ts may contain only runtime export declarations']

  const module = moduleSpecifier(statement)?.text
  const exports = statement.exportClause

  if (!module || !exports || !ts.isNamedExports(exports) || !expected.has(module))
    return ['index.ts exports must use an allowed module and explicit names']

  return exports.elements.flatMap((element) => {
    const token = `${module}:${element.name.text}`

    if (element.propertyName || !expected.get(module)!.has(element.name.text))
      return [`unexpected public export ${token}`]

    if (seen.has(token)) return [`duplicate public export ${token}`]

    seen.add(token)
    return []
  })
}

const EXAMPLE_MANIFEST = `
  import { defineDialect } from '../defineDialect'
  import { exampleIdentity } from './identity'
  import { exampleNaming } from './naming'
  import { exampleSchema } from './schema'
  import { exampleQuery } from './query'
  import { exampleCatalog } from './catalog'
  import { exampleOperations } from './operations'
  import { executeExampleMigration, lowerExampleMigrationPlan } from './migration'

  export const exampleDialect = defineDialect({
    id: 'example',
    identity: exampleIdentity,
    naming: exampleNaming,
    schema: exampleSchema,
    query: exampleQuery,
    catalog: exampleCatalog,
    operations: exampleOperations,
    lower: lowerExampleMigrationPlan,
    execute: executeExampleMigration,
  })
`

const EXAMPLE_REGISTRY = `
  import { exampleDialect } from './example'
  export const productionDialects = [exampleDialect]
`

const EXAMPLE_OPERATIONS = `
  import { createDb0ExampleOperationSessionProvider } from './operationSession'
  export const exampleOperations = {
    createSessionProvider: createDb0ExampleOperationSessionProvider,
    compile: () => ({ sql: 'select 1', params: [] }),
  }
`

const OPERATION_PROVIDER_CLASSIFICATIONS = [
  [
    'a provider imported from the wrong module',
    EXAMPLE_OPERATIONS.replace("from './operationSession'", "from './runtime'"),
    'unaliased import from ./operationSession',
  ],
  [
    'an arbitrarily named provider',
    EXAMPLE_OPERATIONS.replaceAll(
      'createDb0ExampleOperationSessionProvider',
      'createArbitraryProvider',
    ),
    'exampleOperations must use createDb0ExampleOperationSessionProvider',
  ],
] as const

const MANIFEST_CLASSIFICATIONS = [
  ['valid bindings', EXAMPLE_MANIFEST, false],
  [
    'wrong facet source',
    EXAMPLE_MANIFEST.replace("from './identity'", "from './query'"),
    true,
  ],
  ['inline facet', EXAMPLE_MANIFEST.replace('query: exampleQuery', 'query: {}'), true],
  [
    'wrong migration source',
    EXAMPLE_MANIFEST.replace("from './migration'", "from './runtime'"),
    true,
  ],
  [
    'multiple declarations',
    EXAMPLE_MANIFEST.replace(
      'export const exampleDialect =',
      'export const extraDialect = {}, exampleDialect =',
    ),
    true,
  ],
  [
    'non-const declaration',
    EXAMPLE_MANIFEST.replace('export const exampleDialect', 'export let exampleDialect'),
    true,
  ],
] as const

const EXAMPLE_INDEX_SURFACE: IndexSurface = new Map([
  ['./dialect', new Set(['exampleDialect'])],
  ['./operationSession', new Set(['createDb0ExampleOperationSessionProvider'])],
])

const EXAMPLE_INDEX = `
  export { exampleDialect } from './dialect'
  export { createDb0ExampleOperationSessionProvider } from './operationSession'
`

/** Replaces only the valid member export in an otherwise complete fake index. */
function indexFixtureWithMemberExport(memberExport: string): string {
  return EXAMPLE_INDEX.replace("export { exampleDialect } from './dialect'", memberExport)
}

/** Formats the source path and one-based line number of an architecture violation. */
function location(source: ts.SourceFile, node: ts.Node): string {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${relative(ROOT, source.fileName)}:${point.line + 1}`
}

/**
 * Collects syntax nodes in depth-first order, including the root node.
 *
 * @param source - Source syntax tree or text being inspected by the architecture check.
 *
 * @returns Syntax nodes in depth-first order, including the root node.
 */
function descendants(source: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = []

  /** Collects source syntax nodes in depth-first order. */
  const visit = (node: ts.Node) => {
    nodes.push(node)
    node.forEachChild(visit)
  }

  visit(source)
  return nodes
}

/** Reads a literal module specifier from an import or export declaration. */
function moduleSpecifier(node: ts.Node): ts.StringLiteral | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined
  }

  return undefined
}

/**
 * Tests for concrete dialect import in the inspected source node.
 *
 * @param specifier - Literal module specifier inspected for forbidden dependencies.
 *
 * @returns True when the import selects a concrete dialect implementation.
 */
function isConcreteDialectImport(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/')
  const marker = '/dialects/'
  const offset = normalized.indexOf(marker)

  if (offset === -1) return false

  const module = normalized.slice(offset + marker.length)
  return !['catalog', 'resolve', 'types'].includes(module)
}

/** Tests for dialect barrel in the inspected source node. */
function isDialectBarrel(specifier: string): boolean {
  return specifier.replaceAll('\\', '/').endsWith('/dialects')
}

/** Tests for db0 module specifier in the inspected source node. */
function isDb0ModuleSpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/')
  return normalized === 'db0' || normalized.startsWith('db0/')
}

/**
 * Finds a runtime barrel import or export outside the allowed API surface.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns A runtime barrel import or export outside the allowed API surface.
 */
function nonAllowlistedBarrelRuntimeMember(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause

    if (!clause) return '*'
    if (clause.isTypeOnly) return undefined
    if (clause.name) return clause.name.text

    const bindings = clause.namedBindings

    if (!bindings) return undefined
    if (ts.isNamespaceImport(bindings)) return bindings.name.text

    return bindings.elements.find(
      (element) =>
        !element.isTypeOnly &&
        !DIALECT_BARREL_RUNTIME_ALLOWLIST.has(
          (element.propertyName ?? element.name).text,
        ),
    )?.name.text
  }

  if (!ts.isExportDeclaration(node) || node.isTypeOnly) return undefined

  const exports = node.exportClause

  if (!exports) return '*'
  if (ts.isNamespaceExport(exports)) return exports.name.text

  return exports.elements.find(
    (element) =>
      !element.isTypeOnly &&
      !DIALECT_BARREL_RUNTIME_ALLOWLIST.has((element.propertyName ?? element.name).text),
  )?.name.text
}

/**
 * Finds concrete dialect reference evidence in the source syntax tree.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns Concrete dialect reference evidence in the source syntax tree.
 */
function concreteDialectReference(node: ts.Node): string | undefined {
  const specifier = moduleSpecifier(node)

  if (specifier) {
    if (isConcreteDialectImport(specifier.text)) return specifier.text
    if (isDialectBarrel(specifier.text)) return nonAllowlistedBarrelRuntimeMember(node)
  }

  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    (isConcreteDialectImport(node.arguments[0].text) ||
      isDialectBarrel(node.arguments[0].text))
  ) {
    return node.arguments[0].text
  }

  return undefined
}

/**
 * Finds the identifier at the root of a wrapped member or call expression.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns The identifier at the root of a wrapped member or call expression.
 */
function rootIdentifier(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return rootIdentifier(node.expression)

  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node)
  ) {
    return rootIdentifier(node.expression)
  }

  return undefined
}

/**
 * Finds db0 execution reference evidence in the source syntax tree.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns Db0 execution reference evidence in the source syntax tree.
 */
function db0ExecutionReference(node: ts.Node): string | undefined {
  const specifier = moduleSpecifier(node)

  if (specifier && isDb0ModuleSpecifier(specifier.text)) return specifier.text

  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    isDb0ModuleSpecifier(node.arguments[0].text)
  ) {
    return node.arguments[0].text
  }

  const access = ts.isPropertyAccessExpression(node)
    ? node
    : ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      ? node.expression
      : undefined

  if (!access) return undefined

  const method = access.name.text

  if (!['prepare', 'bind', 'all'].includes(method)) return undefined

  const root = rootIdentifier(access.expression)

  if (root && /database|statement|prepared/i.test(root)) {
    return `${root}.${method}`
  }

  return undefined
}

/** Reads an identifier or string property name without interpreting computed keys. */
function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
}

/**
 * Collects property names declared by the requested type or interface.
 *
 * @param source - Source syntax tree or text being inspected by the architecture check.
 * @param declarationName - Type or interface name whose declared properties are
 *   inspected.
 *
 * @returns Property names declared by the requested type or interface.
 */
function declaredPropertyNames(source: ts.SourceFile, declarationName: string): string[] {
  const declaration = descendants(source).find(
    (node) =>
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name.text === declarationName,
  )

  if (!declaration) return []

  return descendants(declaration)
    .flatMap((node) => (ts.isPropertySignature(node) ? [propertyName(node.name)] : []))
    .filter((name): name is string => name !== undefined)
}

/**
 * Tests for connector dialect in the inspected source node.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns True when the syntax refers to a connector dialect selector.
 */
function containsConnectorDialect(node: ts.Node): boolean {
  let found = false

  /**
   * Finds strongly connected action components during dependency-cycle detection.
   *
   * @param candidate - Candidate value or graph action being validated.
   */
  const visit = (candidate: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(candidate) &&
      candidate.name.text === 'dialect' &&
      (candidate.expression.getText().endsWith('.connector') ||
        candidate.expression.getText() === 'connector')
    ) {
      found = true
    }

    candidate.forEachChild(visit)
  }

  visit(node)
  return found
}

/**
 * Tests for dialect policy selector in the inspected source node.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns True when the syntax selects a concrete dialect policy.
 */
function containsDialectPolicySelector(node: ts.Node): boolean {
  let found = containsConnectorDialect(node)

  /**
   * Finds strongly connected action components during dependency-cycle detection.
   *
   * @param candidate - Candidate value or graph action being validated.
   */
  const visit = (candidate: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(candidate) &&
      candidate.name.text === 'id' &&
      candidate.expression.getText().endsWith('dialect')
    ) {
      found = true
    }

    candidate.forEachChild(visit)
  }

  visit(node)
  return found
}

/**
 * Reconstructs SQL template text with placeholders for interpolated values.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns SQL text with interpolated expressions replaced by stable placeholders.
 */
function physicalSqlText(node: ts.StringLiteralLike | ts.TemplateExpression): string {
  if (!ts.isTemplateExpression(node)) return node.text

  return [
    node.head.text,
    ...node.templateSpans.flatMap((span) => ['${value}', span.literal.text]),
  ].join('')
}

/** Tests for physical sql in the inspected source node. */
function looksLikePhysicalSql(value: string): boolean {
  return /^(?:select\s+(?:\d+|.+\s+from\s+)|insert\s+into\s+.+\s+(?:values|select)\s*|update\s+.+\s+set\s+|create\s+(?:table|schema|index)\s+|alter\s+table\s+|drop\s+(?:table|index)\s+|begin\s*$|commit\s*$|rollback(?:\s+to\s+savepoint\s+.+)?\s*$|savepoint\s+|release\s+savepoint\s+)/i.test(
    value.trim(),
  )
}

/**
 * Tests for property in the inspected source node.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param property - Property name checked against the allowed architecture surface.
 *
 * @returns True when property in the inspected source node.
 */
function containsProperty(node: ts.Node, property: string): boolean {
  return descendants(node).some(
    (candidate) =>
      ts.isPropertyAccessExpression(candidate) && candidate.name.text === property,
  )
}

/** Recognizes variables that hold column or index member collections. */
function memberCollectionName(node: ts.Expression): string | undefined {
  if (!ts.isIdentifier(node)) return undefined

  return /(?:column|index)(?:names?)?$/i.test(node.text) ||
    /(?:columns|indexes|columnnames|indexnames)/i.test(node.text)
    ? node.text
    : undefined
}

/**
 * Tests for canonical member array in the inspected source node.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns True when the syntax builds an array of canonical relation-member identifiers.
 */
function isCanonicalMemberArray(node: ts.Expression): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'memberKeys'
  ) {
    return true
  }

  return containsProperty(node, 'comparisonKey')
}

/**
 * Finds raw array comparison leak evidence in the source syntax tree.
 *
 * @param source - Source syntax tree or text being inspected by the architecture check.
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns Raw array comparison leak evidence in the source syntax tree.
 */
function rawArrayComparisonLeak(
  source: ts.SourceFile,
  node: ts.Node,
): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'arraysEqual' ||
    !node.arguments.some((argument) => !isCanonicalMemberArray(argument))
  ) {
    return undefined
  }

  return `${location(source, node)} compares raw member arrays`
}

/**
 * Finds raw collection key leak evidence in the source syntax tree.
 *
 * @param source - Source syntax tree or text being inspected by the architecture check.
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns Raw collection key leak evidence in the source syntax tree.
 */
function rawCollectionKeyLeak(source: ts.SourceFile, node: ts.Node): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !['get', 'has', 'set', 'add'].includes(node.expression.name.text) ||
    !memberCollectionName(node.expression.expression)
  ) {
    return undefined
  }

  const argument = node.arguments.at(0)

  if (
    !argument ||
    !containsProperty(argument, 'name') ||
    containsProperty(argument, 'comparisonKey')
  ) {
    return undefined
  }

  return `${location(source, node)} keys a member collection by raw name`
}

/**
 * Finds raw collection construction leak evidence in the source syntax tree.
 *
 * @param source - Source syntax tree or text being inspected by the architecture check.
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns Raw collection construction leak evidence in the source syntax tree.
 */
function rawCollectionConstructionLeak(
  source: ts.SourceFile,
  node: ts.Node,
): string | undefined {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    (node.expression.text !== 'Map' && node.expression.text !== 'Set') ||
    !ts.isVariableDeclaration(node.parent) ||
    !ts.isIdentifier(node.parent.name) ||
    !memberCollectionName(node.parent.name) ||
    !node.arguments?.some(
      (argument) =>
        containsProperty(argument, 'name') &&
        !containsProperty(argument, 'comparisonKey'),
    )
  ) {
    return undefined
  }

  return `${location(source, node)} constructs a member collection from raw names`
}

/**
 * Finds raw ordering leak evidence in the source syntax tree.
 *
 * @param source - Source syntax tree or text being inspected by the architecture check.
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns Raw ordering leak evidence in the source syntax tree.
 */
function rawOrderingLeak(source: ts.SourceFile, node: ts.Node): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'compareCodeUnits' ||
    node.arguments.length !== 2 ||
    !node.arguments.every(
      (argument) =>
        ts.isPropertyAccessExpression(argument) && argument.name.text === 'name',
    )
  ) {
    return undefined
  }

  return `${location(source, node)} orders members by raw names`
}

/** Finds generic Migration expressions that use member spellings as semantic keys. */
function rawMemberComparisonLeaks(source: ts.SourceFile): string[] {
  return descendants(source).flatMap((node) => {
    const leak =
      rawArrayComparisonLeak(source, node) ??
      rawCollectionKeyLeak(source, node) ??
      rawCollectionConstructionLeak(source, node) ??
      rawOrderingLeak(source, node)

    return leak === undefined ? [] : [leak]
  })
}

describe('production dialect source organization', () => {
  it('requires every registered member to provide the shared source shape and facets', () => {
    const violations = productionDialectSources().flatMap(({ code, directory }) => {
      const missingFiles = REQUIRED_DIALECT_FILES.filter(
        (file) => !existsSync(join(directory, file)),
      ).map((file) => `${code}: missing ${file}`)

      const missingFacets = REQUIRED_DIALECT_FACETS.flatMap((facet) => {
        const file = join(directory, `${facet}.ts`)

        if (!existsSync(file)) return []

        const symbol = `${code}${facet[0]!.toUpperCase()}${facet.slice(1)}`

        const exportsSymbol = parse(file).statements.some(
          (statement) =>
            ts.isVariableStatement(statement) &&
            Boolean(statement.declarationList.flags & ts.NodeFlags.Const) &&
            exportedStatementNames(statement).includes(symbol),
        )

        return exportsSymbol ? [] : [`${code}: ${facet}.ts must export const ${symbol}`]
      })

      return [...missingFiles, ...missingFacets]
    })

    expect(violations).toEqual([])
  })

  it('derives the member symbol from its registered directory', () => {
    expect(productionDialectSources(parseSource(EXAMPLE_REGISTRY))[0]).toMatchObject({
      code: 'example',
      symbol: 'exampleDialect',
    })

    expect(() =>
      productionDialectSources(
        parseSource(EXAMPLE_REGISTRY.replaceAll('exampleDialect', 'arbitraryDialect')),
      ),
    ).toThrow('must register an unaliased exampleDialect import')
  })
})

describe('production dialect shared helpers', () => {
  it('routes desired-schema graphs through the shared lowerer', () => {
    for (const { code, directory } of productionDialectSources()) {
      const imports = namedImportBindings(parse(join(directory, 'lowerDesiredSchema.ts')))

      expect(imports.get('lowerDesiredSchemaGraph'), code).toEqual({
        imported: 'lowerDesiredSchemaGraph',
        module: '@/dialects/lowerDesiredSchema',
      })
    }
  })

  it('shares lifecycle SQL only between the members with identical syntax', () => {
    const sharedMembers = productionDialectSources().filter(({ code }) =>
      ['postgres', 'sqlite'].includes(code),
    )

    for (const { code, directory } of sharedMembers) {
      const imports = namedImportBindings(parse(join(directory, 'operations.ts')))

      expect(imports.get('compileCommonOperationCommand'), code).toEqual({
        imported: 'compileCommonOperationCommand',
        module: '../operations',
      })
    }
  })
})

describe('production dialect source organization: keeps assembly isolated', () => {
  it('keeps each complete member assembly as the only declaration in dialect.ts', () => {
    const violations = productionDialectSources().flatMap((member) =>
      dialectManifestViolations(parse(join(member.directory, 'dialect.ts')), member),
    )

    expect(violations).toEqual([])
  })

  it.each(MANIFEST_CLASSIFICATIONS)('classifies %s', (_name, code, rejected) => {
    const violations = dialectManifestViolations(parseSource(code), {
      symbol: 'exampleDialect',
      code: 'example',
    })

    expect(violations.length > 0).toBe(rejected)
  })

  it.each(OPERATION_PROVIDER_CLASSIFICATIONS)('rejects %s', (_name, code, message) => {
    expect(() =>
      assertOperationSessionProvider(
        parseSource(code),
        'example',
        'createDb0ExampleOperationSessionProvider',
      ),
    ).toThrow(message)
  })
})

describe('production dialect source organization: keeps exports explicit', () => {
  it('uses index.ts only for explicit public exports', () => {
    const violations = productionDialectSources().flatMap((member) =>
      dialectIndexViolations(
        parse(join(member.directory, 'index.ts')),
        dialectIndexSurface(member),
      ),
    )

    expect(violations).toEqual([])
  })
})

describe('production dialect source organization: classifies public indexes', () => {
  it('accepts a complete explicit index', () => {
    expect(
      dialectIndexViolations(parseSource(EXAMPLE_INDEX), EXAMPLE_INDEX_SURFACE),
    ).toEqual([])
  })

  it.each([
    [
      'side-effect import',
      `${EXAMPLE_INDEX}\nimport './setup'`,
      'index.ts may contain only runtime export declarations',
    ],
    [
      'runtime statement',
      `${EXAMPLE_INDEX}\nconst leaked = 1`,
      'index.ts may contain only runtime export declarations',
    ],
    [
      'wildcard export',
      indexFixtureWithMemberExport(`export * from './dialect'`),
      'index.ts exports must use an allowed module and explicit names',
    ],
    [
      'aliased member',
      indexFixtureWithMemberExport(
        `export { internalDialect as exampleDialect } from './dialect'`,
      ),
      'unexpected public export ./dialect:exampleDialect',
    ],
    [
      'wrong member module',
      indexFixtureWithMemberExport(`export { exampleDialect } from './operationSession'`),
      'unexpected public export ./operationSession:exampleDialect',
    ],
    [
      'arbitrary session helper',
      `${EXAMPLE_INDEX}\nexport { helper } from './operationSession'`,
      'unexpected public export ./operationSession:helper',
    ],
  ])('classifies %s', (_name, code, expectedViolation) => {
    const violations = dialectIndexViolations(parseSource(code), EXAMPLE_INDEX_SURFACE)
    expect(violations).toContain(expectedViolation)
  })
})

describe('dialect extension locality architecture', () => {
  it('keeps concrete dialect imports outside Client, Schema, Query, Migration, and Operations', () => {
    const violations = coreFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const reference = concreteDialectReference(node)
        return reference
          ? [`${location(source, node)} imports concrete dialect ${reference}`]
          : []
      })
    })

    expect(violations).toEqual([])
  })
})

describe('dialect extension locality architecture: classifies concrete dialect reference %s', () => {
  it.each(structuredClone(classifiesConcreteDialectReferenceSData))(
    'classifies concrete dialect reference %s',
    (code, rejected) => {
      const source = parseSource(code)

      const references = descendants(source).flatMap((node) =>
        concreteDialectReference(node) ? [node] : [],
      )

      expect(references.length > 0).toBe(rejected)
    },
  )
})

describe('dialect extension locality architecture: keeps db0 transport adaptation out of shared Query, Migration, and Operations', () => {
  it('keeps db0 transport adaptation out of shared Query, Migration, and Operations', () => {
    const violations = sharedExecutionFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const reference = db0ExecutionReference(node)
        return reference ? [`${location(source, node)} references ${reference}`] : []
      })
    })

    expect(violations).toEqual([])
  })

  it.each([
    ['import type { Database } from "db0"', true],
    ['import type { Database } from "db0/connectors/postgresql"', true],
    ["export type { Database } from 'db0'", true],
    ["export type { Database } from 'db0/connectors/postgresql'", true],
    ["import { Database } from 'db0'", true],
    ["import { Database } from 'db0/connectors/postgresql'", true],
    ["export { Database } from 'db0'", true],
    ["export { Database } from 'db0/connectors/postgresql'", true],
    ["const db0 = import('db0')", true],
    ["const db0 = import('db0/connectors/postgresql')", true],
    ['database.prepare("select 1").bind(1).all()', true],
    ['database.prepare("select 1")', true],
    ['statement.bind(1)', true],
    ['statement.all()', true],
    ['executor.run(query)', false],
    ['session.run(query)', false],
    ['executor.execute(query)', false],
  ])('classifies shared execution reference %s', (code, rejected) => {
    const source = parseSource(code)

    const references = descendants(source).flatMap((node) =>
      db0ExecutionReference(node) ? [node] : [],
    )

    expect(references.length > 0).toBe(rejected)
  })
})

describe('dialect extension locality architecture: keeps physical SQL construction inside dialect members', () => {
  it('keeps physical SQL construction inside dialect members', () => {
    const violations = coreFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const semanticKind =
          ts.isStringLiteralLike(node) &&
          ts.isPropertyAssignment(node.parent) &&
          propertyName(node.parent.name) === 'kind'

        const literalSql =
          !semanticKind &&
          (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
          looksLikePhysicalSql(physicalSqlText(node))

        const sqlProperty =
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === 'sql' &&
          (ts.isStringLiteralLike(node.initializer) ||
            ts.isTemplateExpression(node.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(node.initializer))

        if (literalSql || sqlProperty) {
          return [location(source, node)]
        }

        return []
      })
    })

    expect(violations).toEqual([])
  })
})

describe('dialect semantic locality', () => {
  it('keeps engine identifiers and namespace defaults out of executable core code', () => {
    const engineTerms = new Set(['postgresql', 'postgres', 'sqlite', 'mysql', 'public'])
    const violations = coreFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        const engineIdentifier =
          ts.isStringLiteralLike(node) && engineTerms.has(node.text.toLowerCase())

        const namespaceDefault =
          ts.isPropertyAssignment(node) &&
          ['registrationDefault', 'writableDefault'].includes(
            propertyName(node.name) ?? '',
          ) &&
          ts.isArrayLiteralExpression(node.initializer)

        return engineIdentifier || namespaceDefault
          ? [`${location(source, node)} contains engine-specific namespace policy`]
          : []
      })
    })

    expect(violations).toEqual([])
  })
})

describe('dialect semantic locality: keeps authored Schema metadata contracted to structured relation addressing', () => {
  it('keeps authored Schema metadata contracted to structured relation addressing', () => {
    const sharedTypes = parse(join(ROOT, 'src/schemas/actions/types.ts'))
    const tableAction = parse(join(ROOT, 'src/schemas/actions/table.ts'))
    const referenceAction = parse(join(ROOT, 'src/schemas/actions/reference.ts'))

    expect(declaredPropertyNames(sharedTypes, 'TableMetadata')).not.toContain('schema')
    expect(declaredPropertyNames(sharedTypes, 'TableOptions')).not.toContain('schema')

    expect(declaredPropertyNames(tableAction, 'TableActionConfig')).not.toContain(
      'schema',
    )

    expect(declaredPropertyNames(sharedTypes, 'ReferenceMetadata')).not.toContain('table')
    expect(declaredPropertyNames(sharedTypes, 'ReferenceMetadata')).not.toContain('key')

    expect(readFileSync(tableAction.fileName, 'utf8')).not.toMatch(
      /\b(?:config|metadata)\.schema\b/,
    )

    expect(readFileSync(referenceAction.fileName, 'utf8')).not.toMatch(
      /\b(?:metadata|reference)\.(?:table|key)\b/,
    )
  })
})

describe('dialect semantic locality: keeps physical DDL addressing out of generic Migration and Dialect interfaces', () => {
  it('keeps physical DDL addressing out of generic Migration and Dialect interfaces', () => {
    const migrationFiles = sourceFiles('src/ddl')
    const roleViolations = migrationFiles.flatMap((file) => {
      const source = parse(file)
      return descendants(source).flatMap((node) => {
        if (
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === 'role' &&
          ts.isStringLiteralLike(node.initializer) &&
          node.initializer.text === 'schema'
        ) {
          return [location(source, node)]
        }

        return []
      })
    })

    const sharedTypes = parse(join(ROOT, 'src/dialects/types.ts'))

    const physicalDdlTypes = descendants(sharedTypes).flatMap((node) => {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        /^(?:CreateTable|CreateSchema|CreateIndex|AlterTable|AddForeignKey|AddUniqueConstraint|AlterColumn|SetNotNull|Drop)/.test(
          node.name.text,
        )
      ) {
        return [`${location(sharedTypes, node)} declares ${node.name.text}`]
      }

      return []
    })

    const migrationText = migrationFiles
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    expect(roleViolations).toEqual([])
    expect(physicalDdlTypes).toEqual([])
    expect(migrationText).not.toContain('physicalRelationInput')
  })
})

describe('dialect semantic locality: uses canonical comparison keys for generic Migration member reconciliation', () => {
  it('uses canonical comparison keys for generic Migration member reconciliation', () => {
    const source = parse(join(ROOT, 'src/ddl/migrationPlan.ts'))
    expect(rawMemberComparisonLeaks(source)).toEqual([])
  })
})

describe('dialect semantic locality: classifies %s comparison', () => {
  it.each(structuredClone(classifiesSComparisonData))(
    'classifies %s comparison',
    (_label, code, rejected) => {
      expect(rawMemberComparisonLeaks(parseSource(code)).length > 0).toBe(rejected)
    },
  )
})

describe('dialect semantic locality: allows connector dialect only as the resolver input and forbids policy branches', () => {
  it('allows connector dialect only as the resolver input and forbids policy branches', () => {
    const selections: string[] = []
    const branches: string[] = []

    /**
     * Checks one syntax node for forbidden dialect access and physical-policy leakage.
     *
     * @param source - Source syntax tree or text being inspected by the architecture
     *   check.
     * @param node - AST node or dependency-graph node being processed.
     */
    function inspectNode(source: ts.SourceFile, node: ts.Node): void {
      inspectDialectPolicy(node, selections, source, branches)
    }

    for (const file of coreFiles) {
      const source = parse(file)

      for (const node of descendants(source)) inspectNode(source, node)
    }

    expect(selections).toHaveLength(1)
    expect(selections[0]).toMatch(/src[/\\]client\.ts:\d+:resolver$/)
    expect(branches).toEqual([])
  })
})

/**
 * Collects forbidden connector-dialect accesses and physical-policy branches.
 *
 * @param node - Source syntax node to inspect.
 * @param selections - Recorded connector-dialect accesses and their resolver
 *   classification.
 * @param source - Source file used to format violation locations.
 * @param branches - Recorded branches that select concrete dialect policy.
 */
function inspectDialectPolicy(
  node: ts.Node,
  selections: string[],
  source: ts.SourceFile,
  branches: string[],
) {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'dialect' &&
    node.expression.getText() === 'config.connector'
  ) {
    const parent = node.parent
    const selected =
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'resolveDialect'

    selections.push(`${location(source, node)}:${selected ? 'resolver' : 'other'}`)
  }

  if (
    (ts.isIfStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isConditionalExpression(node)) &&
    containsDialectPolicySelector(
      ts.isIfStatement(node)
        ? node.expression
        : ts.isSwitchStatement(node)
          ? node.expression
          : node.condition,
    )
  ) {
    branches.push(location(source, node))
  }
}
