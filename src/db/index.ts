import type { Pool } from 'mysql2/promise';
import { AgentsRepository } from './repositories/agents.js';
import { ContactsRepository } from './repositories/contacts.js';
import { IncomingLogRepository } from './repositories/incoming-log.js';
import { SendLogRepository } from './repositories/send-log.js';
import { SettingsRepository } from './repositories/settings.js';

export interface Repositories {
  pool: Pool;
  agents: AgentsRepository;
  sendLog: SendLogRepository;
  incomingLog: IncomingLogRepository;
  contacts: ContactsRepository;
  settings: SettingsRepository;
}

export const createRepositories = (pool: Pool): Repositories => ({
  pool,
  agents: new AgentsRepository(pool),
  sendLog: new SendLogRepository(pool),
  incomingLog: new IncomingLogRepository(pool),
  contacts: new ContactsRepository(pool),
  settings: new SettingsRepository(pool),
});
