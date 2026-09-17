type Deferred = Readonly<{
  promise: Promise<void>
  resolve(): void
}>

export function deferred(): Deferred {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve,
  }
}
