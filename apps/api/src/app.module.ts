import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { IncidentsModule } from './incidents/incidents.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ProjectsModule } from './projects/projects.module';

@Module({
  imports: [
    InfrastructureModule,
    AuthModule,
    OrganizationsModule,
    ProjectsModule,
    IncidentsModule,
    MonitoringModule,
    HealthModule,
  ],
})
export class AppModule {}
