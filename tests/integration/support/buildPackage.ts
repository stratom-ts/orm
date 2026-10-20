import { build } from 'vite'

/** Builds the package once before any native integration worker imports it. */
export default async function buildPackage() {
  await build({ configFile: 'vite.config.ts', logLevel: 'silent' })
}
