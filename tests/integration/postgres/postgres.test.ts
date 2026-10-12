import { registerDialectIntegrationScenarios } from '../support/dialectIntegrationContract'

import { postgresIntegrationAdapter } from './postgresIntegration'

registerDialectIntegrationScenarios(postgresIntegrationAdapter)
