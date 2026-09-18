import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { OrganizationsModule } from './organizations/organizations.module';

@Module({ imports: [InfrastructureModule, AuthModule, OrganizationsModule, HealthModule] })
export class AppModule {}
