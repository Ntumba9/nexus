import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';

@Module({ imports: [InfrastructureModule, HealthModule] })
export class AppModule {}
