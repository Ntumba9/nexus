import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AutomationController } from './automation.controller';
import { AutomationRulesService } from './automation-rules.service';
import { NotificationsService } from './notifications.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';

@Module({
  imports: [AuditModule],
  controllers: [AutomationController],
  providers: [AutomationRulesService, OutboundWebhooksService, NotificationsService],
})
export class AutomationModule {}
