import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { applyHttpHardening } from './common/hardening.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true }); // raw body: payment webhook signatures
  app.setGlobalPrefix('v1');
  // X-Forwarded-For is trusted only when TRUST_PROXY says how many proxy hops sit in front (e.g. 1 behind one load
  // balancer); unset = use the socket address. Attendance IP allow-lists and rate limits depend on this (D88).
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  app.getHttpAdapter().getInstance().set('trust proxy', Number.isInteger(hops) && hops > 0 ? hops : false);
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','), credentials: true });
  applyHttpHardening(app); // security headers, body cap, request ids, PII-redacting logs (D199)
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
