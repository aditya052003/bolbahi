export const CATALOG = [
  { id: 'rice', name: 'Rice', hindi: 'चावल', pricePerBasePaise: 6000, baseUnit: 'kg', aliases: ['rice', 'chawal', 'चावल'], acceptedUnits: ['kg', 'g'] },
  { id: 'atta', name: 'Atta', hindi: 'आटा', pricePerBasePaise: 4800, baseUnit: 'kg', aliases: ['atta', 'aata', 'आटा'], acceptedUnits: ['kg', 'g'] },
  { id: 'sugar', name: 'Sugar', hindi: 'चीनी', pricePerBasePaise: 4500, baseUnit: 'kg', aliases: ['sugar', 'chini', 'cheeni', 'चीनी', 'शक्कर'], acceptedUnits: ['kg', 'g'] },
  { id: 'oil', name: 'Cooking oil', hindi: 'तेल', pricePerBasePaise: 16500, baseUnit: 'litre', aliases: ['oil', 'tel', 'तेल'], acceptedUnits: ['litre', 'ml'] },
  { id: 'milk', name: 'Milk', hindi: 'दूध', pricePerBasePaise: 6800, baseUnit: 'litre', aliases: ['milk', 'doodh', 'दूध'], acceptedUnits: ['litre', 'ml'] },
  { id: 'dal', name: 'Dal', hindi: 'दाल', pricePerBasePaise: 14000, baseUnit: 'kg', aliases: ['dal', 'daal', 'दाल'], acceptedUnits: ['kg', 'g'] },
  { id: 'salt', name: 'Salt', hindi: 'नमक', pricePerBasePaise: 2500, baseUnit: 'kg', aliases: ['salt', 'namak', 'नमक'], acceptedUnits: ['kg', 'g'] },
  { id: 'biscuits', name: 'Biscuits', hindi: 'बिस्किट', pricePerBasePaise: 1000, baseUnit: 'packet', aliases: ['biscuits', 'biscuit', 'बिस्किट', 'बिस्कुट'], acceptedUnits: ['packet'] },
];

export const UNIT_ALIASES = [
  { unit: 'kg', factor: 1, aliases: ['kilogram', 'kilograms', 'kilo', 'kilos', 'kg', 'किलो', 'किलोग्राम'] },
  { unit: 'g', factor: 0.001, aliases: ['grams', 'gram', 'gm', 'g', 'ग्राम'] },
  { unit: 'litre', factor: 1, aliases: ['litre', 'liter', 'litres', 'liters', 'ltr', 'l', 'लीटर', 'लीटर'] },
  { unit: 'ml', factor: 0.001, aliases: ['millilitre', 'milliliter', 'ml', 'मिलीलीटर', 'मिलीलीटर'] },
  { unit: 'packet', factor: 1, aliases: ['packet', 'packets', 'pack', 'पैकेट'] },
];

export const UNIT_LABELS = {
  kg: 'kg',
  litre: 'litre',
  packet: 'packet',
};

export function priceForQuantityPaise(product, quantityMilli) {
  return Math.round((product.pricePerBasePaise * quantityMilli) / 1000);
}
