import { Controller, Get } from '@nestjs/common';
import { PRODUCT } from '@worko/domain';
import { Public } from '../auth/context.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  get() { return { status: 'ok', product: PRODUCT.name }; }
}
