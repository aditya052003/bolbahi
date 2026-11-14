import { createHash, randomUUID } from 'node:crypto';
import { CATALOG, priceForQuantityPaise } from './catalog.js';
import { createJsonOrderRepository } from './order-repository.js';

export class OrderValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderValidationError';
  }
}

export function normalizeOrder(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > CATALOG.length) {
    throw new OrderValidationError('An order must contain at least one catalogue item.');
  }
  const seen = new Set();
  const normalizedItems = items.map((line) => {
    const product = CATALOG.find((entry) => entry.id === line?.productId);
    if (!product) throw new OrderValidationError('An order line is outside the supported catalogue.');
    if (seen.has(product.id)) throw new OrderValidationError('Each product must appear once in the order.');
    seen.add(product.id);
    if (!Number.isInteger(line.quantityMilli) || line.quantityMilli < 1 || line.quantityMilli > 10_000_000) {
      throw new OrderValidationError(`Enter a valid quantity for ${product.name}.`);
    }
    if (line.unit !== product.baseUnit) throw new OrderValidationError(`Choose ${product.baseUnit} for ${product.name}.`);
    const lineTotalPaise = priceForQuantityPaise(product, line.quantityMilli);
    return {
      productId: product.id,
      name: product.name,
      hindi: product.hindi,
      quantityMilli: line.quantityMilli,
      unit: product.baseUnit,
      pricePerBasePaise: product.pricePerBasePaise,
      lineTotalPaise,
    };
  });
  const totalPaise = normalizedItems.reduce((sum, line) => sum + line.lineTotalPaise, 0);
  const digestInput = normalizedItems.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit }));
  const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
  const spokenLines = normalizedItems.map((line) => `${line.quantityMilli / 1000} ${line.unit} ${line.hindi}`).join(', ');
  const readbackText = `Final order: ${spokenLines}. Total ${totalPaise / 100} rupees.`;
  return { items: normalizedItems, totalPaise, digest, readbackText };
}

function publicOrder(order) {
  const { confirmationToken, historyPartition, historySort, ...safe } = order;
  return safe;
}

export function createOrderService({ storagePath, repository, now = () => new Date() }) {
  const orders = repository ?? createJsonOrderRepository(storagePath);
  const readbacks = new Map();

  return {
    async list() {
      const savedOrders = await orders.list();
      return savedOrders.slice().reverse().map(publicOrder);
    },
    async prepareReadback(items) {
      return normalizeOrder(items);
    },
    issueReadback(digest) {
      const token = randomUUID();
      readbacks.set(token, { digest, expiresAt: Date.now() + 10 * 60 * 1000 });
      return token;
    },
    async confirm({ items, confirmed, readbackToken }) {
      if (confirmed !== true) throw new OrderValidationError('Explicit confirmation is required before saving.');
      const normalized = normalizeOrder(items);
      if (typeof readbackToken !== 'string' || !readbackToken) {
        throw new OrderValidationError('Read the order aloud before confirming it.');
      }

      const prior = await orders.getByConfirmationToken(readbackToken);
      if (prior) return { order: publicOrder(prior), duplicate: true };

      const readback = readbacks.get(readbackToken);
      if (!readback || readback.expiresAt < Date.now() || readback.digest !== normalized.digest) {
        throw new OrderValidationError('Read back this exact order before confirming it.');
      }

      const createdAt = now().toISOString();
      const receiptNumber = `BB-${createdAt.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6).toUpperCase()}`;
      const order = {
        id: randomUUID(),
        receiptNumber,
        createdAt,
        customer: 'Walk-in #104',
        items: normalized.items,
        totalPaise: normalized.totalPaise,
        priceLabel: 'Demo prices',
        confirmationToken: readbackToken,
      };

      const saved = await orders.saveIfAbsent(order);
      readbacks.delete(readbackToken);
      return { order: publicOrder(saved.order), duplicate: saved.duplicate };
    },
  };
}

