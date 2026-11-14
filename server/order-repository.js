import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

async function readJsonOrders(storagePath) {
  try {
    const contents = await readFile(storagePath, 'utf8');
    const parsed = JSON.parse(contents);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function createJsonOrderRepository(storagePath) {
  let writeQueue = Promise.resolve();

  return {
    async list() {
      return readJsonOrders(storagePath);
    },
    async getByConfirmationToken(token) {
      const orders = await readJsonOrders(storagePath);
      return orders.find((order) => order.confirmationToken === token) ?? null;
    },
    async saveIfAbsent(order) {
      const operation = writeQueue.then(async () => {
        const orders = await readJsonOrders(storagePath);
        const prior = orders.find((saved) => saved.confirmationToken === order.confirmationToken);
        if (prior) return { order: prior, duplicate: true };

        await mkdir(dirname(storagePath), { recursive: true });
        const temporaryPath = `${storagePath}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify([...orders, order], null, 2)}\n`, 'utf8');
        await rename(temporaryPath, storagePath);
        return { order, duplicate: false };
      });
      writeQueue = operation.catch(() => {});
      return operation;
    },
  };
}

function marshalValue(value) {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshalValue) };
  if (typeof value === 'object') return { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, marshalValue(item)])) };
  throw new TypeError('Order record contains an unsupported DynamoDB value.');
}

function unmarshalValue(value) {
  if ('S' in value) return value.S;
  if ('N' in value) return Number(value.N);
  if ('BOOL' in value) return value.BOOL;
  if ('NULL' in value) return null;
  if ('L' in value) return value.L.map(unmarshalValue);
  if ('M' in value) return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, unmarshalValue(item)]));
  throw new TypeError('Order record contains an unsupported DynamoDB attribute.');
}

function marshalItem(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, marshalValue(item)]));
}

function unmarshalItem(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmarshalValue(item)]));
}

export function createDynamoOrderRepository({ tableName, client, commandFactory } = {}) {
  if (!tableName) throw new Error('ORDERS_TABLE_NAME is required for DynamoDB order storage.');
  let documentClient = client;
  let commands;

  async function sendCommand(name, input) {
    if (!documentClient || (!commands && !commandFactory)) {
      commands ??= await import('@aws-sdk/client-dynamodb');
      documentClient ??= new commands.DynamoDBClient({});
    }
    const commandInput = name === 'PutItem'
      ? { ...input, Item: marshalItem(input.Item) }
      : name === 'GetItem'
        ? { ...input, Key: marshalItem(input.Key) }
        : input;
    const command = commandFactory ? commandFactory(name, commandInput) : new commands[`${name}Command`](commandInput);
    return documentClient.send(command);
  }

  return {
    async list() {
      const response = await sendCommand('Query', {
        TableName: tableName,
        IndexName: 'orders-by-created',
        KeyConditionExpression: 'historyPartition = :partition',
        ExpressionAttributeValues: { ':partition': { S: 'ORDERS' } },
        ScanIndexForward: false,
        Limit: 100,
      });
      // Query returns the newest rows first; the order service reverses the
      // repository list to present the newest receipt at the top.
      return (response.Items ?? []).map(unmarshalItem).reverse();
    },
    async getByConfirmationToken(token) {
      const response = await sendCommand('GetItem', {
        TableName: tableName,
        Key: { confirmationToken: token },
        ConsistentRead: true,
      });
      return response.Item ? unmarshalItem(response.Item) : null;
    },
    async saveIfAbsent(order) {
      const item = {
        ...order,
        historyPartition: 'ORDERS',
        historySort: `${order.createdAt}#${order.receiptNumber}`,
      };
      try {
        await sendCommand('PutItem', {
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(confirmationToken)',
        });
        return { order: item, duplicate: false };
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        const prior = await this.getByConfirmationToken(order.confirmationToken);
        if (!prior) throw error;
        return { order: prior, duplicate: true };
      }
    },
  };
}
