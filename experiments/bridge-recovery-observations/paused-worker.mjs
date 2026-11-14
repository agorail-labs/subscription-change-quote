// Simulator only. Uses unmodified SCQ source compiled at the pinned commit.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [ref, dir, mode, quoteId] = process.argv.slice(2);
const load = relative => import(pathToFileURL(join(ref, 'dist', relative)).href);
const { DurableQuoteStore } = await load('src/store/durable-store.js');
const { DurableMutationCoordinator } = await load('src/store/mutation-coordinator.js');
const { BusinessIntentLedger, MseScqIntentBridge } = await load('src/integration/business-intent-bridge.js');
const { makeReceipt } = await load('tests/helpers/durable-fixtures.js');

class PausedCoordinator extends DurableMutationCoordinator {
  async execute(intent, dispatch) {
    // MseScqIntentBridge invokes this method only AFTER acquiring its claim.
    // Pause before the original coordinator can write an SCQ attempt.
    writeFileSync(join(dir, 'ready'), 'CLAIM_PRESENT_NO_SCQ_ATTEMPT');
    const deadline = Date.now() + 15000;
    while (!existsSync(join(dir, 'resume'))) {
      if (Date.now() > deadline) throw Error('Parent did not resume paused worker');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return super.execute(intent, dispatch);
  }
}

const ledger = new BusinessIntentLedger(join(dir, 'intent.sqlite'));
const store = new DurableQuoteStore(join(dir, 'scq.sqlite'), { recoveryGraceMs: 60000 });
try {
  const Coordinator = mode === 'pause' ? PausedCoordinator : DurableMutationCoordinator;
  const bridge = new MseScqIntentBridge(ledger, new Coordinator(store));
  const business = {
    tenantId: 'tenant-a', businessIntentId: 'approved-action-1', actorId: 'customer-7',
    authorizationRef: 'approval-1', provider: 'chargebee', site: 'site-1',
    subscriptionId: 'sub_1', operation: { action: 'CHANGE_QUANTITY', itemId: 'item_1', quantity: 2 }, quoteId,
  };
  const mutation = {
    quoteId, subscriptionId: 'sub_1', provider: 'chargebee', site: 'site-1',
    request: { items: [{ id: 'item_1', quantity: 2 }], replace_items_list: false },
    idempotencyKey: `key-${quoteId}`,
  };
  const admission = { fixture: 'synthetic-admission' };
  const result = await bridge.execute(business, mutation, {
    // Synthetic trust callbacks, as in existing bridge isolation tests.
    authorize: async () => {
      appendFileSync(join(dir, 'authorization-checks.log'), `${quoteId}\n`);
      if (existsSync(join(dir, 'approval-revoked'))) {
        throw Object.assign(Error('Synthetic customer approval withdrawn'), { code: 'APPROVAL_REVOKED' });
      }
    },
    admission: async () => ({ kind: 'PASSED', report: admission }),
    validatePassedAdmission: report => { if (report !== admission) throw Error('Fixture mismatch'); },
    validateCommercial: async () => {},
  }, async () => {
    appendFileSync(join(dir, 'effects.log'), `${quoteId}\n`);
    if (mode === 'lost-response') {
      throw Object.assign(Error('Synthetic provider response lost after effect'), { code: 'LOST_RESPONSE' });
    }
    return { type: 'receipt', receipt: makeReceipt(quoteId) };
  });
  process.stdout.write(JSON.stringify({ kind: result.kind, originalQuoteId: result.originalQuoteId }) + '\n');
} catch (error) {
  if (!['APPROVAL_REVOKED', 'LOST_RESPONSE'].includes(error.code)) throw error;
  process.stdout.write(JSON.stringify({ kind: 'ERROR', code: error.code }) + '\n');
} finally {
  ledger.close();
  store.close();
}
