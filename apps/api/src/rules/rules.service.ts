import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { diffSchedules, lateFeeTableSchema, loadPack, schedule, type ClientFacts, type Extension, type LateFeeTable, type RulePack } from '@worko/rules';

@Injectable()
export class RulesService {
  /** The shipped (seed) pack — installed per tenant by RulePackService; SAMPLE DATA, UNVERIFIED. */
  readonly pack: RulePack = loadPack(JSON.parse(readFileSync(require.resolve('@worko/rules/packs/in-seed.json'), 'utf8')));
  /** Indicative late-fee/interest tables (data; UNVERIFIED). */
  readonly lateFees: LateFeeTable = lateFeeTableSchema.parse(JSON.parse(readFileSync(require.resolve('@worko/rules/packs/in-latefees-seed.json'), 'utf8')));

  preview(clients: ClientFacts[], fy: number, extensions: Extension[] = []) {
    return schedule({ pack: this.pack, clients, fy, extensions });
  }

  extensionImpact(clients: ClientFacts[], fy: number, extensions: Extension[]) {
    const { changes, dueDatesChanged, clientsAffected } = diffSchedules(this.preview(clients, fy), this.preview(clients, fy, extensions));
    return { dueDatesChanged, clientsAffected, changes };
  }
}
