import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MembersService } from './members.service';
import { MembersController, OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [AuditModule],
  controllers: [OrganizationsController, MembersController],
  providers: [OrganizationsService, MembersService],
})
export class OrganizationsModule {}
