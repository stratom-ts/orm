import { postgresIntegrationAdapter } from './postgresIntegration'
import { registerDialectIntegrationScenarios } from './support/dialectIntegrationContract'

registerDialectIntegrationScenarios(postgresIntegrationAdapter)
