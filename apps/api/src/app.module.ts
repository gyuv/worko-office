import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { MockSmsProvider, SMS_PROVIDER } from './auth/sms.provider.js';
import { TokenService } from './auth/token.service.js';
import { ErrorFilter } from './common/error.filter.js';
import { DbService } from './db/db.service.js';
import { HealthController } from './health/health.controller.js';
import { RulesController } from './rules/rules.controller.js';
import { RulesService } from './rules/rules.service.js';
import { TenancyController } from './tenancy/tenancy.controller.js';
import { TenancyService } from './tenancy/tenancy.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ limit: Number(process.env.RATE_LIMIT ?? 300), ttl: 60_000 }])],
  controllers: [HealthController, RulesController, AuthController, UsersController, AuditController, TenancyController],
  providers: [
    DbService, AuditService, TokenService, AuthService, TenancyService, UsersService, RulesService,
    { provide: SMS_PROVIDER, useClass: MockSmsProvider },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
