type Deferred = Readonly<{
  promise: Promise<void>
  /** Resolves authored relation intent into role-tagged canonical identity. */
  resolve(): void
}>

/**
 * Creates a promise whose settlement is controlled by the test.
 *
 * @returns A promise whose settlement is controlled by the test.
 */
export function deferred(): Deferred {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve,
  }
}
