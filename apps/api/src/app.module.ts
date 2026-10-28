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
import { ClientsController } from './clients/clients.controller.js';
import { ClientsService } from './clients/clients.service.js';
import { ImportController } from './clients/import.controller.js';
import { ImportService } from './clients/import.service.js';
import { VisibilityService } from './clients/visibility.service.js';
import { KeyService, KMS_PROVIDER, LocalKms } from './crypto/key.service.js';
import { DocumentsController } from './documents/documents.controller.js';
import { DocumentsService } from './documents/documents.service.js';
import { GSTIN_LOOKUP, MockGstinLookup } from './lookup/gstin.provider.js';
import { RegistersController } from './registers/registers.controller.js';
import { RegistersService } from './registers/registers.service.js';
import { MockVirusScanner, STORAGE, storageFactory, VIRUS_SCANNER } from './storage/storage.js';
import { VaultController } from './vault/vault.controller.js';
import { VaultService } from './vault/vault.service.js';
import { ComplianceController } from './compliance/compliance.controller.js';
import { ComplianceService } from './compliance/compliance.service.js';
import { RulePackService } from './compliance/rule-pack.service.js';
import { AutoTaskService } from './tasks/auto.service.js';
import { CatalogueService } from './tasks/catalogue.service.js';
import { TasksController } from './tasks/tasks.controller.js';
import { TasksService } from './tasks/tasks.service.js';
import { BillingAutoService } from './billing/auto.service.js';
import { BillingController } from './billing/billing.controller.js';
import { CollectionsService } from './billing/collections.service.js';
import { BillingConfigService } from './billing/config.service.js';
import { InvoicesService } from './billing/invoices.service.js';
import { CLIENT_MESSENGER, MockMessenger, PAYMENT_PROVIDERS, paymentProvidersFactory } from './billing/providers.js';
import { ReceiptsService } from './billing/receipts.service.js';
import { Clock } from './common/clock.js';
import { BillingReportsService } from './billing/reports.service.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ limit: Number(process.env.RATE_LIMIT ?? 300), ttl: 60_000 }])],
  controllers: [HealthController, RulesController, AuthController, UsersController, AuditController, TenancyController,
    SyncController, NotificationsController, TeamsController,
    ImportController, ClientsController, VaultController, DocumentsController, RegistersController,
    TasksController, ComplianceController, BillingController],
  providers: [
    DbService, AuditService, TokenService, AuthService, TenancyService, UsersService, RulesService,
    RealtimeService, RealtimeGateway, JobQueueService, SyncService, NotificationsService,
    { provide: SYNC_TABLES_TOKEN, useValue: SYNC_TABLES },
    ClientsService, VisibilityService, ImportService, VaultService, DocumentsService, RegistersService, KeyService,
    RulePackService, CatalogueService, TasksService, AutoTaskService, ComplianceService,
    { provide: Clock, useFactory: () => new Clock() },
    BillingConfigService, InvoicesService, ReceiptsService, BillingAutoService, BillingReportsService, CollectionsService,
    { provide: CLIENT_MESSENGER, useFactory: () => new MockMessenger() },
    { provide: PAYMENT_PROVIDERS, useFactory: paymentProvidersFactory },
    { provide: KMS_PROVIDER, useFactory: () => new LocalKms() },
    { provide: STORAGE, useFactory: storageFactory },
    { provide: VIRUS_SCANNER, useClass: MockVirusScanner },
    { provide: GSTIN_LOOKUP, useClass: MockGstinLookup },
    { provide: PUSH_PROVIDERS, useFactory: pushProvidersFactory },
    { provide: SMS_PROVIDER, useClass: MockSmsProvider },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
