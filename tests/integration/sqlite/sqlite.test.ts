import { registerDialectIntegrationScenarios } from '../support/dialectIntegrationContract'

import { sqliteIntegrationAdapter } from './sqliteIntegration'

registerDialectIntegrationScenarios(sqliteIntegrationAdapter)
