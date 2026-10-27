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
import { JobQueueService } from './jobs/job-queue.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { PUSH_PROVIDERS, pushProvidersFactory } from './notifications/push.providers.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';
import { RealtimeService } from './realtime/realtime.service.js';
import { SYNC_TABLES, SYNC_TABLES_TOKEN } from './sync/registry.js';
import { SyncController } from './sync/sync.controller.js';
import { SyncService } from './sync/sync.service.js';
import { TeamsController } from './teams/teams.controller.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ limit: Number(process.env.RATE_LIMIT ?? 300), ttl: 60_000 }])],
  controllers: [HealthController, RulesController, AuthController, UsersController, AuditController, TenancyController,
    SyncController, NotificationsController, TeamsController],
  providers: [
    DbService, AuditService, TokenService, AuthService, TenancyService, UsersService, RulesService,
    RealtimeService, RealtimeGateway, JobQueueService, SyncService, NotificationsService,
    { provide: SYNC_TABLES_TOKEN, useValue: SYNC_TABLES },
    { provide: PUSH_PROVIDERS, useFactory: pushProvidersFactory },
    { provide: SMS_PROVIDER, useClass: MockSmsProvider },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
