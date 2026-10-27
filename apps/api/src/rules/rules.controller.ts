import { Body, Controller, Get, Post } from '@nestjs/common';
import { extensionSchema } from '@worko/rules';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { RulesService } from './rules.service.js';

const previewSchema = z.object({
  fy: z.number().int().min(2017).max(2100),
  clients: z.array(z.object({ id: z.string() }).passthrough()).max(5000),
  extensions: z.array(extensionSchema).default([]),
});
type PreviewBody = z.infer<typeof previewSchema>;

@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get('pack')
  pack() {
    const { id, version, notes, rules } = this.rules.pack;
    return { id, version, notes, rules: rules.map((r) => ({ id: r.id, form: r.form, regime: r.regime, frequency: r.frequency, verified: r.verified })) };
  }

  @Post('preview')
  preview(@Body(new ZodPipe(previewSchema)) b: PreviewBody) { return this.rules.preview(b.clients, b.fy, b.extensions); }

  @Post('extension-impact')
  impact(@Body(new ZodPipe(previewSchema)) b: PreviewBody) { return this.rules.extensionImpact(b.clients, b.fy, b.extensions); }
}
