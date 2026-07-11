// Secrets come from the shared env-storage repo, not a local .env (SPEC.md §10).
import { config } from 'dotenv';
import { z } from 'zod';

config({ path: '/Users/caseybrown/Claude/env-storage/.env' });

export const env = z
  .object({
    SMARTLEAD_API_KEY: z.string().min(1, 'SMARTLEAD_API_KEY missing from env-storage/.env'),
    AIRTABLE_PAT: z.string().min(1, 'AIRTABLE_PAT missing from env-storage/.env'),
    // Workspace to create new lead bases in (e.g. `apollo:to-airtable`). Only needed when creating
    // a base; reads/writes to an existing base don't use it.
    AIRTABLE_WORKSPACE_ID: z.string().optional(),
    // Infra provisioning — only the `infra:*` commands need these, so they are optional and the
    // adapters assert presence at call time. Spaceship = registrar + DNS; InboxKit = mailbox host
    // + warmup. NOTE: the Spaceship API key is stored under SPACESHIP_API (not SPACESHIP_API_KEY).
    SPACESHIP_API: z.string().optional(),
    SPACESHIP_API_SECRET: z.string().optional(),
    INBOX_KIT_API: z.string().optional(),
    // Apollo lead export — only the `apollo:*` commands need this, so it is optional and the
    // client asserts presence at call time.
    APOLLO_API_KEY: z.string().optional(),
    // ZeroBounce email verification — only the `verify:*` commands need this, so it is optional
    // and the client asserts presence at call time. Stored under EMAIL_VERIFIER_API_KEY (generic
    // name), not ZEROBOUNCE_*.
    EMAIL_VERIFIER_API_KEY: z.string().optional(),
    // Consulti.ai lead database — only the `consulti:*` commands need this, so it is optional
    // and the client asserts presence at call time. Full API reference: docs/consulti-api.md.
    CONSULTI_API_KEY: z.string().optional(),
  })
  .parse(process.env);
