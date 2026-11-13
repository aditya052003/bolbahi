import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCorrection, parseOrder, parseSpokenOrder, validateParsedOrder } from '../shared/order-parser.js';
import { CATALOG, priceForQuantityPaise } from '../shared/catalog.js';

test('UI transcript path keeps a preceding oil addition and resolves rice quantity', () => {
  const parsed = parseSpokenOrder('किलो चावल और एक लीटर तेल नहीं, चावल चार किलो कर दो।');
  assert.deepEqual(parsed.items.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit })), [
    { productId: 'rice', quantityMilli: 4000, unit: 'kg' },
    { productId: 'oil', quantityMilli: 1000, unit: 'litre' },
  ]);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.totalPaise, 40500);
});

test('UI transcript path scopes a punctuation-separated nahi to the next item', () => {
  const parsed = parseSpokenOrder('दो किलो चावल और एक लीटर तेल। नहीं, चावल चार किलो कर दो।');
  assert.deepEqual(parsed.items.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit })), [
    { productId: 'rice', quantityMilli: 4000, unit: 'kg' },
    { productId: 'oil', quantityMilli: 1000, unit: 'litre' },
  ]);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.totalPaise, 40500);
});

test('resolving rice does not clear a different item’s missing details', () => {
  const parsed = parseSpokenOrder('किलो चावल और दूध नहीं, चावल चार किलो कर दो।');
  assert.equal(parsed.items.find((item) => item.productId === 'rice').quantityMilli, 4000);
  assert.equal(parsed.items.find((item) => item.productId === 'milk').quantityMilli, null);
  assert.ok(parsed.issues.some((issue) => issue.productId === 'milk' && issue.type === 'missing_quantity'));
  assert.ok(!parsed.issues.some((issue) => issue.productId === 'rice' && issue.type === 'missing_quantity'));
});

test('UI correction path sets rice to four kilos and preserves oil', () => {
  const starting = parseOrder('तीन किलो चावल और एक लीटर तेल');
  const corrected = applyCorrection('चावल चार किलो कर दो।', starting.items);
  assert.deepEqual(corrected.items.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit })), [
    { productId: 'rice', quantityMilli: 4000, unit: 'kg' },
    { productId: 'oil', quantityMilli: 1000, unit: 'litre' },
  ]);
  assert.equal(corrected.totalPaise, 40500);
});

test('correction SET is idempotent when applied more than once', () => {
  const starting = parseOrder('तीन किलो चावल और एक लीटर तेल');
  const first = applyCorrection('chawal chaar kilo kar do', starting.items);
  const second = applyCorrection('chawal chaar kilo kar do', first.items);
  assert.equal(first.items.find((item) => item.productId === 'rice').quantityMilli, 4000);
  assert.equal(second.items.find((item) => item.productId === 'rice').quantityMilli, 4000);
  assert.equal(second.totalPaise, 40500);
});

test('explicit addition phrases add to the current quantity in Hindi and English', () => {
  const starting = parseOrder('तीन किलो चावल और एक लीटर तेल');
  const hindi = applyCorrection('दो किलो चावल और जोड़ दो', starting.items);
  const english = applyCorrection('add two more kilos of rice', starting.items);
  assert.equal(hindi.items.find((item) => item.productId === 'rice').quantityMilli, 5000);
  assert.equal(hindi.totalPaise, 46500);
  assert.equal(hindi.issues.length, 0);
  assert.equal(english.items.find((item) => item.productId === 'rice').quantityMilli, 5000);
  assert.equal(english.totalPaise, 46500);
  assert.equal(english.issues.length, 0);
});

test('correction quantity conversion stays in the product base unit', () => {
  const starting = parseOrder('तीन किलो चावल और एक लीटर तेल');
  const setGrams = applyCorrection('chawal 400 gram kar do', starting.items);
  const addGrams = applyCorrection('add 500 g rice', starting.items);
  assert.equal(setGrams.items.find((item) => item.productId === 'rice').quantityMilli, 400);
  assert.equal(setGrams.items.find((item) => item.productId === 'rice').unit, 'kg');
  assert.equal(setGrams.totalPaise, 18900);
  assert.equal(addGrams.items.find((item) => item.productId === 'rice').quantityMilli, 3500);
  assert.equal(addGrams.totalPaise, 37500);
});

test('correction without a clear set or add instruction asks for clarification', () => {
  const starting = parseOrder('तीन किलो चावल और एक लीटर तेल');
  const ambiguous = applyCorrection('chawal chaar kilo', starting.items);
  assert.equal(ambiguous.items.find((item) => item.productId === 'rice').quantityMilli, 3000);
  assert.ok(ambiguous.issues.some((issue) => issue.type === 'ambiguous'));
  assert.equal(ambiguous.totalPaise, 34500);
});

test('spoken correction replaces the original quantity instead of adding to it', () => {
  const parsed = parseOrder('Do kilo chawal aur ek litre tel. Nahi, chawal teen kilo kar do.');
  assert.deepEqual(parsed.items.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit })), [
    { productId: 'rice', quantityMilli: 3000, unit: 'kg' },
    { productId: 'oil', quantityMilli: 1000, unit: 'litre' },
  ]);
  assert.equal(parsed.totalPaise, 34500);
  assert.equal(validateParsedOrder(parsed), true);
});

test('spoken removal deletes only the named catalogue line', () => {
  const parsed = parseOrder('Do kilo chawal aur ek kilo dal. Dal hata do.');
  assert.deepEqual(parsed.items.map(({ productId, quantityMilli }) => ({ productId, quantityMilli })), [{ productId: 'rice', quantityMilli: 2000 }]);
  assert.deepEqual(parsed.issues, []);
});

test('aadha and dedh convert to exact milli-units in Roman Hinglish', () => {
  const parsed = parseOrder('Aadha kilo chawal aur dedh litre doodh');
  assert.deepEqual(parsed.items.map(({ productId, quantityMilli }) => ({ productId, quantityMilli })), [
    { productId: 'rice', quantityMilli: 500 },
    { productId: 'milk', quantityMilli: 1500 },
  ]);
  assert.equal(parsed.totalPaise, 13200);
});

test('Devanagari names, quantities, and units are supported', () => {
  const parsed = parseOrder('डेढ़ लीटर दूध और आधा किलो चीनी');
  assert.deepEqual(parsed.items.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit })), [
    { productId: 'milk', quantityMilli: 1500, unit: 'litre' },
    { productId: 'sugar', quantityMilli: 500, unit: 'kg' },
  ]);
  assert.equal(parsed.issues.length, 0);
});

test('a known product with missing quantity or unit requires clarification', () => {
  const missingQuantity = parseOrder('Chawal');
  assert.equal(missingQuantity.items[0].quantityMilli, null);
  assert.ok(missingQuantity.issues.some((issue) => issue.type === 'missing_quantity'));
  assert.equal(validateParsedOrder(missingQuantity), false);

  const missingUnit = parseOrder('Do chawal');
  assert.equal(missingUnit.items[0].quantityMilli, 2000);
  assert.equal(missingUnit.items[0].unit, null);
  assert.ok(missingUnit.issues.some((issue) => issue.type === 'missing_unit'));
  assert.equal(validateParsedOrder(missingUnit), false);
});

test('unrecognized products and ambiguous phrases are flagged for review', () => {
  const unknown = parseOrder('Do kilo apples');
  assert.equal(unknown.items.length, 0);
  assert.ok(unknown.issues.some((issue) => issue.type === 'missing_product'));
  assert.equal(validateParsedOrder(unknown), false);

  const ambiguous = parseOrder('Chawal atta do kilo');
  assert.ok(ambiguous.issues.some((issue) => issue.type === 'ambiguous'));
  assert.equal(validateParsedOrder(ambiguous), false);

  const competingQuantities = parseOrder('Chawal do kilo teen kilo');
  assert.ok(competingQuantities.issues.some((issue) => issue.type === 'ambiguous'));
  assert.equal(competingQuantities.items.length, 0);
});

test('prices and totals use whole paise with explicit rounding', () => {
  const milk = CATALOG.find((item) => item.id === 'milk');
  assert.equal(priceForQuantityPaise(milk, 1500), 10200);
  assert.equal(priceForQuantityPaise(milk, 1), 7);
  const parsed = parseOrder('Do kilo atta aur aadha kilo namak');
  assert.equal(parsed.totalPaise, 10850);
});

