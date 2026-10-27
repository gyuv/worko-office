import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { RulesController } from './rules/rules.controller.js';
import { RulesService } from './rules/rules.service.js';

@Module({ controllers: [HealthController, RulesController], providers: [RulesService] })
export class AppModule {}
