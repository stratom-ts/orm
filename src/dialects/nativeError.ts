/** Reads a native diagnostic without letting a hostile getter hide the original error. */
export function nativeField(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * Visits a native failure and its causes once, including cyclic cause chains.
 *
 * @yields Each distinct object in the native cause chain.
 */
export function* nativeCauses(cause: unknown): Generator<object> {
  const seen = new Set<object>()
  let current = cause

  while (
    ((typeof current === 'object' && current !== null) ||
      typeof current === 'function') &&
    !seen.has(current)
  ) {
    seen.add(current)
    yield current
    current = nativeField(current, 'cause')
  }
}
