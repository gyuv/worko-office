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
import { CLIENT_MESSENGER, PAYMENT_PROVIDERS, paymentProvidersFactory } from './billing/providers.js';
import { ReceiptsService } from './billing/receipts.service.js';
import { Clock } from './common/clock.js';
import { BillingReportsService } from './billing/reports.service.js';
import { TimeController } from './time/time.controller.js';
import { TimeService } from './time/time.service.js';
import { TimeReportsService } from './time/reports.service.js';
import { HrController } from './hr/hr.controller.js';
import { HrConfigService } from './hr/config.service.js';
import { AttendanceService } from './hr/attendance.service.js';
import { LeaveService } from './hr/leave.service.js';
import { ExpensesService } from './hr/expenses.service.js';
import { BroadcastService } from './comm/broadcast.service.js';
import { CalendarService } from './comm/calendar.service.js';
import { channelAdaptersFactory, COMM_CHANNELS_TOKEN, INBOUND_PROVIDERS, inboundProvidersFactory, MockChannelHub, OAUTH_PROVIDERS, oauthProvidersFactory } from './comm/channels.js';
import { CommMessenger } from './comm/billing-messenger.js';
import { BookingAdminController, BookingPublicController, CalendarController, ChatController } from './comm/chat.controller.js';
import { ChatService } from './comm/chat.service.js';
import { CommController, TimelineController } from './comm/comm.controller.js';
import { CommService } from './comm/comm.service.js';
import { ConnectionsService } from './comm/connections.service.js';
import { AuditWorkService } from './practice/audit.service.js';
import { DscService } from './practice/dsc.service.js';
import { ESIGN_PROVIDERS, esignProvidersFactory } from './practice/esign.provider.js';
import { EsignService } from './practice/esign.service.js';
import { NOTICE_EXTRACTORS, noticeExtractorsFactory } from './practice/extractor.js';
import { NoticesService } from './practice/notices.service.js';
import { AuditWorkController, DscController, EsignController, NoticesController } from './practice/practice.controller.js';
import { PracticeService } from './practice/practice.service.js';
import { PortalAdminService } from './portal/admin.service.js';
import { PortalAuthService } from './portal/portal-auth.service.js';
import { PortalAdminController, PortalController, PortalPublicController } from './portal/portal.controller.js';
import { PortalService } from './portal/portal.service.js';
import { LeadsController, ProposalsController } from './leads/leads.controller.js';
import { LeadsService } from './leads/leads.service.js';
import { ProposalsService } from './leads/proposals.service.js';
import { AiController } from './ai/ai.controller.js';
import { AiService } from './ai/ai.service.js';
import { ReportEngine } from './reports/engine.js';
import { NlQueryService } from './reports/nlquery.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { ReportScheduleService } from './reports/schedule.service.js';
import { AI_PROVIDER, aiProviderFactory } from './ai/provider.js';
import { ActionRunner } from './automation/actions.js';
import { AutomationController } from './automation/automation.controller.js';
import { AutomationService } from './automation/automation.service.js';
import { AutomationEngine } from './automation/engine.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ limit: Number(process.env.RATE_LIMIT ?? 300), ttl: 60_000 }])],
  controllers: [HealthController, RulesController, AuthController, UsersController, AuditController, TenancyController,
    SyncController, NotificationsController, TeamsController,
    ImportController, ClientsController, VaultController, DocumentsController, RegistersController,
    TasksController, ComplianceController, BillingController, TimeController, HrController,
    CommController, TimelineController, ChatController, CalendarController, BookingAdminController, BookingPublicController,
    NoticesController, AuditWorkController, DscController, EsignController,
    PortalPublicController, PortalController, PortalAdminController, LeadsController, ProposalsController, AutomationController, AiController, ReportsController],
  providers: [
    DbService, AuditService, TokenService, AuthService, TenancyService, UsersService, RulesService,
    RealtimeService, RealtimeGateway, JobQueueService, SyncService, NotificationsService,
    { provide: SYNC_TABLES_TOKEN, useValue: SYNC_TABLES },
    ClientsService, VisibilityService, ImportService, VaultService, DocumentsService, RegistersService, KeyService,
    RulePackService, CatalogueService, TasksService, AutoTaskService, ComplianceService,
    { provide: Clock, useFactory: () => new Clock() },
    BillingConfigService, InvoicesService, ReceiptsService, BillingAutoService, BillingReportsService, CollectionsService,
    TimeService, TimeReportsService, HrConfigService, AttendanceService, LeaveService, ExpensesService,
    CommService, BroadcastService, ChatService, CalendarService, ConnectionsService,
    NoticesService, AuditWorkService, DscService, EsignService, PracticeService,
    PortalAuthService, PortalService, PortalAdminService, LeadsService, ProposalsService,
    AiService, { provide: AI_PROVIDER, useFactory: aiProviderFactory }, ActionRunner, AutomationEngine, AutomationService, ReportEngine, ReportsService, ReportScheduleService, NlQueryService,
    { provide: NOTICE_EXTRACTORS, useFactory: noticeExtractorsFactory },
    { provide: ESIGN_PROVIDERS, useFactory: esignProvidersFactory },
    { provide: MockChannelHub, useFactory: () => new MockChannelHub() },
    { provide: COMM_CHANNELS_TOKEN, useFactory: channelAdaptersFactory, inject: [MockChannelHub] },
    { provide: INBOUND_PROVIDERS, useFactory: inboundProvidersFactory },
    { provide: OAUTH_PROVIDERS, useFactory: oauthProvidersFactory },
    // Billing messages go through the communication pipeline (consent, quiet hours, caps, timeline — D98).
    CommMessenger, { provide: CLIENT_MESSENGER, useExisting: CommMessenger },
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
