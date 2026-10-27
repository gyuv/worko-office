import { Controller, Get } from '@nestjs/common';
import { PRODUCT } from '@worko/domain';

@Controller('health')
export class HealthController {
  @Get()
  get() { return { status: 'ok', product: PRODUCT.name }; }
}
