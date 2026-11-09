/**
 * @typedef {Parameters<import('oxlint/plugins-dev').RuleTester['run']>[1]} LintRule
 *
 * @typedef {Parameters<NonNullable<LintRule['create']>>[0]} RuleContext
 *
 * @typedef {RuleContext['sourceCode']} SourceCode
 *
 * @typedef {NonNullable<ReturnType<SourceCode['getNodeByRangeIndex']>>} SyntaxNode
 *
 * @typedef {ReturnType<SourceCode['getCommentsAfter']>[number]} SourceComment
 *
 * @typedef {NonNullable<ReturnType<SourceCode['getLastToken']>> | SourceComment} SourceAnchor
 */

/**
 * Reads the source token that ends a statement for whitespace boundary checks.
 *
 * @param {SourceCode} sourceCode - Parsed source used to find statement tokens.
 * @param {SyntaxNode} node - Statement whose last token is required.
 */
function getActualLastToken(sourceCode, node) {
  return /** @type {NonNullable<ReturnType<SourceCode['getLastToken']>>} */ (
    sourceCode.getLastToken(node)
  )
}

/**
 * Recognizes immediately invoked function statements through chain and unary wrappers.
 *
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function isIifeStatement(node) {
  if (node.type !== 'ExpressionStatement') {
    return false
  }

  let { expression } = node

  if (expression.type === 'ChainExpression') {
    expression = expression.expression
  }

  if (expression.type === 'UnaryExpression') {
    expression = expression.argument
  }

  if (expression.type === 'ChainExpression') {
    expression = expression.expression
  }

  return (
    expression.type === 'CallExpression' &&
    (expression.callee.type === 'ArrowFunctionExpression' ||
      expression.callee.type === 'FunctionExpression')
  )
}

/**
 * Checks whether a statement ends in an owned block or an immediately invoked function.
 *
 * @param {SourceCode} sourceCode - Parsed source with token and comment lookup used by
 *   whitespace checks.
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function isBlockLikeStatement(sourceCode, node) {
  if (node.type === 'DoWhileStatement' && node.body.type === 'BlockStatement') {
    return true
  }

  if (isIifeStatement(node)) {
    return true
  }

  let lastToken = getActualLastToken(sourceCode, node)

  if (lastToken.value === ';') {
    lastToken = /** @type {ReturnType<typeof getActualLastToken>} */ (
      sourceCode.getTokenBefore(lastToken)
    )
  }

  if (lastToken.value !== '}') {
    return false
  }

  const owner = sourceCode.getNodeByRangeIndex(lastToken.range[0])
  return owner?.type === 'BlockStatement' || owner?.type === 'SwitchStatement'
}

/**
 * Recognizes calls through await and optional-chain wrappers.
 *
 * @param {SyntaxNode} expression - Expression whose nested call structure is inspected.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function isCallExpression(expression) {
  if (expression.type === 'CallExpression') {
    return true
  }

  if (expression.type === 'AwaitExpression') {
    return isCallExpression(expression.argument)
  }

  if (expression.type === 'ChainExpression') {
    return isCallExpression(expression.expression)
  }

  return false
}

/**
 * Tests whether a statement is a call spanning more than one source line.
 *
 * @param {SyntaxNode} node - Statement to inspect.
 */
function isMultilineCallStatement(node) {
  return (
    node.type === 'ExpressionStatement' &&
    node.loc.start.line !== node.loc.end.line &&
    isCallExpression(node.expression)
  )
}

/**
 * Counts chained calls through member and optional-chain expressions.
 *
 * @param {SyntaxNode} expression - Expression whose nested call structure is inspected.
 *
 * @returns {number} The number of calls in the expression chain.
 */
function callChainDepth(expression) {
  if (expression.type === 'ChainExpression') {
    return callChainDepth(expression.expression)
  }

  if (expression.type === 'CallExpression') {
    return 1 + callChainDepth(expression.callee)
  }

  if (expression.type === 'MemberExpression') {
    return callChainDepth(expression.object)
  }

  return 0
}

/**
 * Recognizes declarations whose chained calls span multiple source lines.
 *
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function isMultilineCallChainDeclaration(node) {
  return (
    node.type === 'VariableDeclaration' &&
    node.loc.start.line !== node.loc.end.line &&
    node.declarations.some(
      (declaration) => declaration.init !== null && callChainDepth(declaration.init) > 1,
    )
  )
}

/**
 * Recognizes multiline const declarations that require trailing whitespace.
 *
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {boolean} True when the declaration spans multiple source lines.
 */
function isMultilineConstDeclaration(node) {
  return (
    node.type === 'VariableDeclaration' &&
    node.kind === 'const' &&
    node.declarations.some(
      (declaration) => declaration.loc.start.line !== declaration.loc.end.line,
    )
  )
}

/**
 * Recognizes type declarations whose source layout requires surrounding whitespace.
 *
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function isMultilineTypeDeclaration(node) {
  const declaration =
    node.type === 'ExportNamedDeclaration' && node.declaration !== null
      ? node.declaration
      : node

  return (
    (declaration.type === 'TSTypeAliasDeclaration' ||
      declaration.type === 'TSInterfaceDeclaration') &&
    declaration.loc.start.line !== declaration.loc.end.line
  )
}

/**
 * Recognizes statements with multiline block bodies.
 *
 * @param {SourceCode} sourceCode - Parsed source used to find statement tokens.
 * @param {SyntaxNode} node - Statement to inspect.
 */
function isMultilineBlockStatement(sourceCode, node) {
  return (
    node.loc.start.line !== node.loc.end.line && isBlockLikeStatement(sourceCode, node)
  )
}

/**
 * Selects statement forms that require a surrounding blank line.
 *
 * @param {SourceCode} sourceCode - Parsed source used to find statement tokens.
 * @param {SyntaxNode} node - Statement to inspect.
 */
function isPaddedMultilineStatement(sourceCode, node) {
  return (
    isMultilineBlockStatement(sourceCode, node) ||
    isMultilineCallStatement(node) ||
    isMultilineCallChainDeclaration(node) ||
    isMultilineTypeDeclaration(node)
  )
}

/**
 * Recognizes compact guards that should remain adjacent to related statements.
 *
 * @param {SyntaxNode} node - Statement to inspect.
 */
function isSingleLineIfStatement(node) {
  return node.type === 'IfStatement' && node.loc.start.line === node.loc.end.line
}

/**
 * Collects local names from nested variable-binding patterns.
 *
 * @param {SyntaxNode} pattern - Binding pattern whose declared names must be collected.
 * @param {Set<string>} names - Mutable set of local binding names used for dependency
 *   detection.
 */
function addBindingNames(pattern, names) {
  if (pattern.type === 'Identifier') {
    names.add(pattern.name)
    return
  }

  if (pattern.type === 'RestElement') {
    addBindingNames(pattern.argument, names)
    return
  }

  if (pattern.type === 'AssignmentPattern') {
    addBindingNames(pattern.left, names)
    return
  }

  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements.filter((element) => element !== null)) {
      addBindingNames(element, names)
    }

    return
  }

  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      addBindingNames(
        property.type === 'RestElement' ? property.argument : property.value,
        names,
      )
    }
  }
}

/**
 * Tests whether a node references a name introduced by the preceding declaration.
 *
 * @param {unknown} value - Runtime value to validate, normalize, or map.
 * @param {Set<string>} names - Mutable set of local binding names used for dependency
 *   detection.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function containsBindingReference(value, names) {
  if (value === null || typeof value !== 'object') {
    return false
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsBindingReference(item, names))
  }

  if ('type' in value && value.type === 'Identifier' && 'name' in value) {
    return typeof value.name === 'string' && names.has(value.name)
  }

  return Object.entries(value).some(
    ([key, child]) =>
      key !== 'parent' &&
      key !== 'loc' &&
      key !== 'range' &&
      containsBindingReference(child, names),
  )
}

/**
 * Checks whether a declaration supplies values used by the following block.
 *
 * @param {SyntaxNode} previousNode - Previous statement whose trailing token or attached
 *   comment anchors the gap.
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function declarationFeedsBlock(previousNode, node) {
  if (previousNode.type !== 'VariableDeclaration') {
    return false
  }

  if (previousNode.loc.start.line !== previousNode.loc.end.line) {
    return false
  }

  const names = new Set(/** @type {string[]} */ ([]))
  for (const declaration of previousNode.declarations) {
    addBindingNames(declaration.id, names)
  }

  return containsBindingReference(node, names)
}

/**
 * Checks whether a declaration supplies values used by the following statement.
 *
 * @param {SourceCode} sourceCode - Parsed source with token and comment lookup used by
 *   whitespace checks.
 * @param {SyntaxNode} previousNode - Previous statement whose trailing token or attached
 *   comment anchors the gap.
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function declarationFeedsNode(sourceCode, previousNode, node) {
  if (
    previousNode.type !== 'VariableDeclaration' ||
    (previousNode.kind !== 'const' && previousNode.kind !== 'let')
  ) {
    return false
  }

  return sourceCode
    .getDeclaredVariables(previousNode)
    .some((variable) =>
      variable.references.some(
        (reference) =>
          reference.isRead() &&
          reference.identifier.range[0] >= node.range[0] &&
          reference.identifier.range[1] <= node.range[1],
      ),
    )
}

/**
 * Applies the repository's statement separation rules to adjacent statements.
 *
 * @param {SourceCode} sourceCode - Parsed source with token and comment lookup used by
 *   whitespace checks.
 * @param {SyntaxNode} previousNode - Previous statement whose trailing token or attached
 *   comment anchors the gap.
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 * @param {SourceComment | null} leadingComment - Leading comment attached to the next statement,
 *   or null when none exists.
 *
 * @returns {boolean} True when the inspected syntax requires this statement
 *   classification.
 */
function requiresBlankLineBetween(sourceCode, previousNode, node, leadingComment) {
  const consecutiveSingleLineIfs =
    leadingComment === null &&
    isSingleLineIfStatement(previousNode) &&
    isSingleLineIfStatement(node)

  if (consecutiveSingleLineIfs) {
    return false
  }

  if (
    isPaddedMultilineStatement(sourceCode, previousNode) ||
    isMultilineConstDeclaration(previousNode) ||
    previousNode.type === 'IfStatement'
  ) {
    return true
  }

  if (node.type === 'IfStatement') {
    return true
  }

  const nodeIsMultilineBlock = isMultilineBlockStatement(sourceCode, node),
    nodeIsMultilineCall = isMultilineCallStatement(node),
    nodeRequiresLeadingBlankLine = isPaddedMultilineStatement(sourceCode, node),
    nodeConsumesPreviousDeclaration =
      (nodeIsMultilineBlock && declarationFeedsBlock(previousNode, node)) ||
      (nodeIsMultilineCall && declarationFeedsNode(sourceCode, previousNode, node))

  return (
    (nodeRequiresLeadingBlankLine && !nodeConsumesPreviousDeclaration) ||
    (node.loc.start.line === node.loc.end.line && leadingComment !== null)
  )
}

/**
 * Finds the token or attached comment that ends the previous statement.
 *
 * @param {SourceCode} sourceCode - Parsed source with token and comment lookup used by
 *   whitespace checks.
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {SourceAnchor} The token or attached comment ending the previous statement.
 */
function getTrailingAnchor(sourceCode, node) {
  /** @type {SourceAnchor} */
  let anchor = getActualLastToken(sourceCode, node)

  for (const comment of sourceCode.getCommentsAfter(node)) {
    if (comment.loc.start.line !== anchor.loc.end.line) {
      break
    }

    anchor = comment
  }

  return anchor
}

/**
 * Finds a comment that must stay attached to the following statement.
 *
 * @param {SourceCode} sourceCode - Parsed source with token and comment lookup used by
 *   whitespace checks.
 * @param {SyntaxNode} previousNode - Previous statement whose trailing token or attached
 *   comment anchors the gap.
 * @param {SyntaxNode} node - Syntax node whose statement form and source boundaries are
 *   inspected.
 *
 * @returns {SourceComment | null} The leading comment attached to the statement, or null
 *   when none exists.
 */
function getAttachedLeadingComment(sourceCode, previousNode, node) {
  const comments = sourceCode
    .getCommentsBefore(node)
    .filter((comment) => comment.loc.start.line > previousNode.loc.end.line)

  let firstAttached = null,
    nextLine = node.loc.start.line

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]

    if (nextLine - comment.loc.end.line > 1) {
      break
    }

    firstAttached = comment
    nextLine = comment.loc.start.line
  }

  return firstAttached
}

/**
 * Locates the source anchors that bound the whitespace between two statements.
 *
 * @param {SourceCode} sourceCode - Parsed source with token lookup used by whitespace
 *   fixes.
 * @param {SyntaxNode} previousNode - Statement before the boundary.
 * @param {SyntaxNode} node - Statement after the boundary.
 * @param {SourceComment | null} leadingComment - Comment attached to the next statement.
 *
 * @returns {{ anchor: SourceAnchor; target: SourceAnchor }} Tokens or comments bounding the
 *   whitespace gap.
 */
function getStatementBoundary(sourceCode, previousNode, node, leadingComment) {
  let anchor = getTrailingAnchor(sourceCode, previousNode),
    target =
      leadingComment ?? /** @type {SourceAnchor} */ (sourceCode.getFirstToken(node))
  const lastDeclaration =
    previousNode.type === 'VariableDeclaration'
      ? previousNode.declarations.at(-1)
      : undefined

  // A leading ASI-protection semicolon can be tokenized as the terminator of the
  // preceding declaration. Treat it as the start of the following statement so fixes
  // put whitespace before the semicolon instead of splitting it from its expression.
  if (
    leadingComment === null &&
    lastDeclaration !== undefined &&
    'value' in anchor &&
    anchor.value === ';' &&
    anchor.loc.start.line > lastDeclaration.loc.end.line
  ) {
    target = anchor
    anchor = /** @type {SourceAnchor} */ (sourceCode.getTokenBefore(anchor))
  }

  return { anchor, target }
}

/**
 * Reads indentation at a source node's start for whitespace fixes.
 *
 * @param {string} source - Full source text.
 * @param {number} offset - Start offset whose indentation is required.
 */
function getIndent(source, offset) {
  const lineStart = Math.max(source.lastIndexOf('\n', offset - 1) + 1, 0)
  return /^[\t ]*/u.exec(source.slice(lineStart, offset))?.[0] ?? ''
}

/**
 * Reports and fixes incorrect blank-line separation between adjacent statements.
 *
 * @param {RuleContext} context - Lint rule context providing source lookup and diagnostic
 *   reporting.
 * @param {SyntaxNode[]} statements - Adjacent statements whose blank-line separation must be
 *   checked.
 */
function checkStatementList(context, statements) {
  const { sourceCode } = context
  const source = sourceCode.text,
    lineBreak = source.includes('\r\n') ? '\r\n' : '\n'

  for (let index = 1; index < statements.length; index += 1) {
    const previousNode = statements[index - 1],
      node = statements[index],
      leadingComment = getAttachedLeadingComment(sourceCode, previousNode, node)

    if (!requiresBlankLineBetween(sourceCode, previousNode, node, leadingComment)) {
      continue
    }

    const { anchor, target } = getStatementBoundary(
      sourceCode,
      previousNode,
      node,
      leadingComment,
    )

    const between = source.slice(anchor.range[1], target.range[0])

    // A detached comment between the statements is its own visual group. Leave it alone.
    if (!/^\s*$/u.test(between)) {
      continue
    }

    if (target.loc.start.line - anchor.loc.end.line === 2) {
      continue
    }

    context.report({
      /** Produces source replacements that enforce the required statement separation. */
      fix(fixer) {
        const indent = getIndent(source, target.range[0])
        return fixer.replaceTextRange(
          [anchor.range[1], target.range[0]],
          `${lineBreak}${lineBreak}${indent}`,
        )
      },
      messageId: 'expectedSingleBlankLine',
      node,
    })
  }
}

/** @type {LintRule} */
const padMultilineBlocks = {
  /**
   * Creates the whitespace rule listener for statement lists.
   *
   * @param {RuleContext} context - Lint rule context providing source lookup and diagnostic
   *   reporting.
   *
   * @returns {ReturnType<NonNullable<LintRule['create']>>} Statement-list visitors for
   *   the whitespace rule.
   */
  create(context) {
    return {
      /** Checks statement separation in the program body. */
      'Program:exit'(node) {
        checkStatementList(context, node.body)
      },
      /** Checks statement separation in a block body. */
      'BlockStatement:exit'(node) {
        checkStatementList(context, node.body)
      },
      /** Checks statement separation in a static initialization block. */
      'StaticBlock:exit'(node) {
        checkStatementList(context, node.body)
      },
      /** Checks statement separation in a switch case. */
      'SwitchCase:exit'(node) {
        checkStatementList(context, node.consequent)
      },
      /** Checks statement separation in a TypeScript namespace body. */
      'TSModuleBlock:exit'(node) {
        checkStatementList(context, node.body)
      },
    }
  },
  meta: {
    docs: {
      description:
        'Require one blank line around if statements, multiline blocks, multiline calls, call chains, const declarations, and types',
    },
    fixable: 'whitespace',
    messages: {
      expectedSingleBlankLine: 'Expected exactly one blank line at this code boundary.',
    },
    schema: [],
    type: 'layout',
  },
}

export default padMultilineBlocks
