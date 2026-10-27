import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { diffSchedules, loadPack, schedule, type ClientFacts, type Extension, type RulePack } from '@worko/rules';

@Injectable()
export class RulesService {
  readonly pack: RulePack = loadPack(JSON.parse(readFileSync(require.resolve('@worko/rules/packs/in-seed.json'), 'utf8')));

  preview(clients: ClientFacts[], fy: number, extensions: Extension[] = []) {
    return schedule({ pack: this.pack, clients, fy, extensions });
  }

  extensionImpact(clients: ClientFacts[], fy: number, extensions: Extension[]) {
    const { changes, dueDatesChanged, clientsAffected } = diffSchedules(this.preview(clients, fy), this.preview(clients, fy, extensions));
    return { dueDatesChanged, clientsAffected, changes };
  }
}
