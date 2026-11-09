/**
 * @typedef {Parameters<import('oxlint/plugins-dev').RuleTester['run']>[1]} LintRule
 *
 * @typedef {Parameters<NonNullable<LintRule['create']>>[0]} RuleContext
 *
 * @typedef {RuleContext['sourceCode']} SourceCode
 *
 * @typedef {NonNullable<ReturnType<SourceCode['getNodeByRangeIndex']>>} SyntaxNode
 */

const factories = new Set(['each', 'for', 'skipIf', 'runIf'])
const modifiers = new Set(['only', 'skip', 'todo', 'fails', 'concurrent', 'sequential'])

/**
 * Reads a static member name, including bracket notation.
 *
 * @param {SyntaxNode} node - Member expression to inspect.
 */
function memberName(node) {
  if (node.type !== 'MemberExpression') return undefined

  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && node.property.type === 'Literal') return node.property.value

  return undefined
}

/**
 * Resolves Vitest imports while excluding shadowed and unrelated bindings.
 *
 * @param {SourceCode} sourceCode - Source with lexical scope information.
 * @param {Extract<SyntaxNode, { type: 'Identifier' }>} node - Identifier used by the
 *   call.
 */
function vitestBinding(sourceCode, node) {
  const variable = sourceCode
    .getScope(node)
    .references.find((reference) => reference.identifier === node)?.resolved

  const definition = variable?.defs.at(0)

  if (!definition) return node.name
  if (definition.type !== 'ImportBinding') return undefined
  if (definition.parent?.type !== 'ImportDeclaration') return undefined
  if (definition.parent.source.value !== 'vitest') return undefined

  const specifier = definition.node

  if (specifier.type === 'ImportNamespaceSpecifier') return '*'
  if (specifier.type !== 'ImportSpecifier') return undefined

  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value
}

/**
 * Recognizes test registration through Vitest modifiers and parameterized factories.
 *
 * @param {SourceCode} sourceCode - Source used to resolve imported bindings.
 * @param {SyntaxNode} node - Callee of a possible test registration.
 *
 * @returns {boolean} Whether the callee registers a Vitest test.
 */
function isTestCallee(sourceCode, node) {
  if (node.type === 'Identifier')
    return ['it', 'test'].includes(vitestBinding(sourceCode, node))

  if (node.type === 'MemberExpression') {
    const name = memberName(node)

    if (node.object.type === 'Identifier' && (name === 'it' || name === 'test'))
      return vitestBinding(sourceCode, node.object) === '*'

    return (
      typeof name === 'string' &&
      (modifiers.has(name) || factories.has(name)) &&
      isTestCallee(sourceCode, node.object)
    )
  }

  const factory =
    node.type === 'CallExpression'
      ? node.callee
      : node.type === 'TaggedTemplateExpression'
        ? node.tag
        : undefined

  return (
    factory?.type === 'MemberExpression' &&
    factories.has(memberName(factory)) &&
    isTestCallee(sourceCode, factory.object)
  )
}

/** @type {LintRule} */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require Vitest test titles to start with should' },
    schema: [],
    messages: { missingShould: 'Test titles must start with "should".' },
  },
  /**
   * Checks the known prefix of string and template test titles.
   *
   * @param {RuleContext} context - Lint context providing source and diagnostics.
   */
  create(context) {
    return {
      /** Checks registrations, excluding calls that only configure a factory. */
      CallExpression(node) {
        if (factories.has(memberName(node.callee))) return
        if (!isTestCallee(context.sourceCode, node.callee)) return

        const title = node.arguments.at(0)
        const prefix =
          title?.type === 'Literal'
            ? title.value
            : title?.type === 'TemplateLiteral'
              ? title.quasis[0].value.cooked
              : undefined

        // Forwarded title variables cannot be checked without evaluating user code.
        if (typeof prefix !== 'string' || /^should(?:\s|$)/u.test(prefix)) return

        context.report({ node: title, messageId: 'missingShould' })
      },
    }
  },
}
