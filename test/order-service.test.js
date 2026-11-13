import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOrderService, OrderValidationError } from '../server/order-service.js';

const completeItems = [
  { productId: 'rice', quantityMilli: 1500, unit: 'kg' },
  { productId: 'milk', quantityMilli: 500, unit: 'litre' },
];

test('saving requires explicit confirmation and a matching completed read-back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bolbahi-test-'));
  try {
    const service = createOrderService({ storagePath: join(directory, 'orders.json'), now: () => new Date('2026-11-13T10:00:00.000Z') });
    const prepared = await service.prepareReadback(completeItems);
    await assert.rejects(
      service.confirm({ items: completeItems, confirmed: false, readbackToken: 'missing' }),
      (error) => error instanceof OrderValidationError && /confirmation/i.test(error.message),
    );
    await assert.rejects(
      service.confirm({ items: completeItems, confirmed: true, readbackToken: '' }),
      (error) => error instanceof OrderValidationError && /read the order aloud/i.test(error.message),
    );

    const readbackToken = service.issueReadback(prepared.digest);
    await assert.rejects(
      service.confirm({ items: [{ ...completeItems[0], quantityMilli: 2000 }, completeItems[1]], confirmed: true, readbackToken }),
      (error) => error instanceof OrderValidationError && /exact order/i.test(error.message),
    );

    const saved = await service.confirm({ items: completeItems, confirmed: true, readbackToken });
    assert.equal(saved.duplicate, false);
    assert.equal(saved.order.totalPaise, 12400);
    assert.equal(saved.order.priceLabel, 'Demo prices');
    assert.equal(saved.order.customer, 'Walk-in #104');
    assert.equal('confirmationToken' in saved.order, false);

    const duplicate = await service.confirm({ items: completeItems, confirmed: true, readbackToken });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.order.id, saved.order.id);
    assert.equal((await service.list()).length, 1);
    const persisted = JSON.parse(await readFile(join(directory, 'orders.json'), 'utf8'));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].totalPaise, 12400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

