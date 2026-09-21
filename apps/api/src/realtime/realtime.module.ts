import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MutationSignalInterceptor } from './mutation-signal.interceptor';
import { RealtimeController } from './realtime.controller';
import { RealtimeHub } from './realtime.hub';

@Module({
  controllers: [RealtimeController],
  providers: [RealtimeHub, { provide: APP_INTERCEPTOR, useClass: MutationSignalInterceptor }],
  exports: [RealtimeHub],
})
export class RealtimeModule {}
