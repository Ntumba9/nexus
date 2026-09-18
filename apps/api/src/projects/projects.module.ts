import { Module } from '@nestjs/common';
import { ProjectsController, ServicesController } from './projects.controller';
import { ProjectsService, ServicesService } from './projects.service';

@Module({
  controllers: [ProjectsController, ServicesController],
  providers: [ProjectsService, ServicesService],
})
export class ProjectsModule {}
