import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProjectsController, ServicesController } from './projects.controller';
import { ProjectsService, ServicesService } from './projects.service';

@Module({
  imports: [AuditModule],
  controllers: [ProjectsController, ServicesController],
  providers: [ProjectsService, ServicesService],
})
export class ProjectsModule {}
