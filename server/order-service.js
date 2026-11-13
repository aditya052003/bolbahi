import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CATALOG, priceForQuantityPaise } from '../shared/catalog.js';

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
  const { confirmationToken, ...safe } = order;
  return safe;
}

export function createOrderService({ storagePath, now = () => new Date() }) {
  const readbacks = new Map();
  let writeQueue = Promise.resolve();

  async function readOrders() {
    try {
      const contents = await readFile(storagePath, 'utf8');
      const parsed = JSON.parse(contents);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function persist(orders) {
    await mkdir(dirname(storagePath), { recursive: true });
    const temporaryPath = `${storagePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(orders, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, storagePath);
  }

  return {
    async list() {
      const orders = await readOrders();
      return orders.slice().reverse().map(publicOrder);
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

      const priorOrders = await readOrders();
      const prior = priorOrders.find((order) => order.confirmationToken === readbackToken);
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

      writeQueue = writeQueue.then(async () => {
        const latest = await readOrders();
        const concurrentDuplicate = latest.find((saved) => saved.confirmationToken === readbackToken);
        if (concurrentDuplicate) return concurrentDuplicate;
        await persist([...latest, order]);
        return order;
      });
      const saved = await writeQueue;
      readbacks.delete(readbackToken);
      return { order: publicOrder(saved), duplicate: saved.id !== order.id };
    },
  };
}

