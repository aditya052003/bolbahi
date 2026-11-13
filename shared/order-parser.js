import { CATALOG, UNIT_ALIASES, priceForQuantityPaise } from './catalog.js';

const NUMBER_WORDS = new Map([
  ['zero', 0], ['shunya', 0], ['शून्य', 0],
  ['ek', 1], ['एक', 1], ['one', 1],
  ['do', 2], ['दो', 2], ['two', 2],
  ['teen', 3], ['तीन', 3], ['three', 3],
  ['char', 4], ['chaar', 4], ['चार', 4], ['four', 4],
  ['paanch', 5], ['panch', 5], ['पाँच', 5], ['पांच', 5], ['five', 5],
  ['chhe', 6], ['छह', 6], ['छः', 6], ['six', 6],
  ['saat', 7], ['सात', 7], ['seven', 7],
  ['aath', 8], ['आठ', 8], ['eight', 8],
  ['nau', 9], ['नौ', 9], ['nine', 9],
  ['das', 10], ['दस', 10], ['ten', 10],
  ['aadha', 0.5], ['aadhi', 0.5], ['half', 0.5], ['आधा', 0.5], ['आधी', 0.5],
  ['dedh', 1.5], ['डेढ़', 1.5], ['ढाई', 2.5], ['dhai', 2.5],
]);

const FILLER_WORDS = new Set([
  'aur', 'and', 'please', 'pleasee', 'bhej', 'dena', 'de', 'do', 'kar', 'karo', 'kijiye', 'chahiye', 'chahie',
  'mujhe', 'bas', 'thoda', 'sa', 'wala', 'wali', 'ke', 'liye', 'lao', 'bhejdo', 'bhej', 'order', 'nahi', 'nahin', 'na',
  'नहीं', 'नही', 'और', 'भेज', 'देना', 'दे', 'दो', 'कर', 'करो', 'चाहिए', 'मुझे', 'बस', 'थोड़ा', 'सा', 'लाओ', 'ऑर्डर',
  'kar', 'dijiye', 'dijiye', 'hatao', 'hata', 'nikal', 'nikaal', 'mat', 'remove', 'delete', 'cancel', 'set', 'change', 'instead',
  'add', 'more', 'increase', 'by', 'to', 'it', 'with', 'of', 'jod', 'jodo', 'हटा', 'हटाओ', 'जोड़', 'जोड', 'जोड़ो', 'निकाल', 'निकालो', 'मत', 'चाहिए', 'करदो', 'कर', 'दीजिए',
]);

const CORRECTION = /\b(?:nahi|nahin|correction|actually|instead|change|replace)\b|नहीं|नही|सुधार/iu;
const REMOVAL = /\b(?:hata(?:o|a|do|iye)?|hatado|nikaal(?:o|iye)?|remove|delete|cancel|mat dena|nahi chahiye|nahin chahiye|no longer|don't want)\b|हटा(?:ओ|दो)?|निकाल(?:ो)?|मत देना|नहीं चाहिए/iu;
const SET_INSTRUCTION = /\b(?:kar\s+do|kar\s+dijiye|set(?:\s+(?:it\s+)?to)?|change\s+(?:it\s+)?to|replace\s+(?:it\s+)?with)\b|कर\s*दो|कर\s*दीजिए|कर\s*दीजिये|करदो/iu;
const ADD_INSTRUCTION = /\b(?:add(?:\s+more)?|more|increase\s+by|jod(?:\s+do)?|jodo)\b|और\s*जोड़(?:\s*दो)?|जोड़\s*दो/iu;
const CORRECTION_BOUNDARY = /\b(?:nahi|nahin|correction|actually|instead|change|replace)\b|नहीं(?!\s+चाहिए)|नही|सुधार/giu;
const SEGMENT_SPLIT = /[\r\n]+|[,;.!?।]+|\b(?:aur|and|plus)\b(?!\s*(?:jod(?:\s+do)?|add(?:\s+more)?))|और(?!\s*जोड़(?:\s*दो)?)/giu;

function normalize(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-IN').replace(/[०-९]/g, (digit) => String('०१२३४५६७८९'.indexOf(digit))).replace(/[’']/g, ' ');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAlias(text, alias) {
  const expression = new RegExp(`(^|[^a-z0-9\\u0900-\\u097f])${escapeRegex(alias)}($|[^a-z0-9\\u0900-\\u097f])`, 'iu');
  return expression.test(text);
}

function findProducts(text) {
  const found = [];
  for (const product of CATALOG) {
    if (product.aliases.some((alias) => hasAlias(text, normalize(alias)))) found.push(product);
  }
  return found;
}

function readQuantities(text) {
  const cleaned = text.replace(/\b(?:kar|de|bhej|jod)\s+do\b|(?:कर|दे|भेज|जोड़)\s+दो/giu, ' ');
  const tokens = cleaned.match(/[a-z]+|[०-९0-9]+(?:[.,][०-९0-9]+)?|[\u0900-\u097f]+/giu) ?? [];
  const quantities = [];
  for (const token of tokens) {
    const canonical = normalize(token).replace(/[,.]/g, '.');
    if (NUMBER_WORDS.has(canonical)) quantities.push(NUMBER_WORDS.get(canonical));
    else if (/^\d+(?:\.\d+)?$/.test(canonical)) quantities.push(Number(canonical));
  }
  return quantities;
}

function readUnit(text) {
  for (const entry of UNIT_ALIASES) {
    if (entry.aliases.some((alias) => hasAlias(text, normalize(alias)))) return entry;
  }
  return null;
}

function makeIssue(type, text, message, productId = null) {
  const stableInput = `${type}:${productId ?? ''}:${normalize(text.trim())}`;
  let hash = 2166136261;
  for (const character of stableInput) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return { id: `${type}-${(hash >>> 0).toString(36)}`, type, text: text.trim(), message, productId, reviewed: false };
}

function unknownWords(text, productMatches, unitEntry) {
  let remaining = ` ${text} `;
  for (const product of productMatches) {
    for (const alias of product.aliases) {
      remaining = remaining.replace(new RegExp(`(^|[^a-z0-9\\u0900-\\u097f])${escapeRegex(normalize(alias))}($|[^a-z0-9\\u0900-\\u097f])`, 'giu'), ' ');
    }
  }
  if (unitEntry) {
    for (const alias of unitEntry.aliases) {
      remaining = remaining.replace(new RegExp(`(^|[^a-z0-9\\u0900-\\u097f])${escapeRegex(normalize(alias))}($|[^a-z0-9\\u0900-\\u097f])`, 'giu'), ' ');
    }
  }
  remaining = remaining.replace(/[०-९0-9]+(?:[.,][०-९0-9]+)?/g, ' ');
  for (const [word] of NUMBER_WORDS) {
    remaining = remaining.replace(new RegExp(`(^|[^a-z0-9\\u0900-\\u097f])${escapeRegex(word)}($|[^a-z0-9\\u0900-\\u097f])`, 'giu'), ' ');
  }
  const words = remaining.match(/[a-z]+|[\u0900-\u097f]+/giu) ?? [];
  return words.filter((word) => !FILLER_WORDS.has(normalize(word)));
}

function toMilli(value) {
  return Math.round(value * 1000);
}

function splitIntoClauses(transcript) {
  return normalize(transcript)
    .replace(CORRECTION_BOUNDARY, '\n$&\n')
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function parseOrder(transcript, existingItems = [], { mode = 'order' } = {}) {
  const items = existingItems.map((item) => ({ ...item }));
  let issues = [];
  let correctionPending = false;
  const segments = splitIntoClauses(transcript);

  for (const segment of segments) {
    const correctionMarker = correctionPending || CORRECTION.test(segment);
    const setIntent = correctionMarker || SET_INSTRUCTION.test(segment);
    const addIntent = ADD_INSTRUCTION.test(segment);
    const isCorrection = setIntent && !addIntent;
    const isRemoval = REMOVAL.test(segment);
    const products = findProducts(segment);
    if (!products.length) {
      if (CORRECTION.test(segment) && !/[0-9]|एक|दो|तीन|ek|do|teen|aadha|dedh/u.test(segment)) {
        correctionPending = true;
        continue;
      }
      correctionPending = false;
      const quantities = readQuantities(segment);
      const qty = quantities[0] ?? null;
      const unit = readUnit(segment);
      const unknown = unknownWords(segment, [], unit);
      if (quantities.length > 1) issues.push(makeIssue('ambiguous', segment, 'More than one quantity appears without a clear item split. Clarify the amount.'));
      if (qty !== null || unit || unknown.length) {
        const type = qty !== null || unit ? 'missing_product' : 'unrecognized';
        const message = type === 'missing_product' ? 'Product missing. Which catalogue item did the customer mean?' : 'This phrase is outside the supported kirana catalogue; review it before continuing.';
        issues.push(makeIssue(type, segment, message));
      }
      continue;
    }

    correctionPending = false;
    const quantities = readQuantities(segment);
    if (quantities.length > 1) {
      issues.push(makeIssue('ambiguous', segment, 'More than one quantity appears for this item. Clarify the intended amount.', products.length === 1 ? products[0].id : null));
      continue;
    }
    const quantity = quantities[0] ?? null;
    const unitEntry = readUnit(segment);
    const unknown = unknownWords(segment, products, unitEntry);
    if (unknown.length) issues.push(makeIssue('unrecognized', segment, `Could not interpret “${unknown.join(' ')}”. Review this phrase.`));

    if (products.length > 1) {
      issues.push(makeIssue('ambiguous', segment, 'More than one catalogue item appears in this phrase. Split or correct it manually.'));
      continue;
    }

    const product = products[0];
    if (isRemoval) {
      const index = items.findIndex((item) => item.productId === product.id);
      if (index < 0) {
        issues.push(makeIssue('missing_removal_target', segment, `There is no ${product.name} line to remove.`, product.id));
      } else {
        items.splice(index, 1);
      }
      continue;
    }

    if (mode === 'correction' && !isCorrection && !addIntent) {
      issues.push(makeIssue('ambiguous', segment, `Should this set the ${product.name} quantity or add more? Say “kar do” to set it or “jod do” to add.`, product.id));
      continue;
    }

    const validUnit = unitEntry && product.acceptedUnits.includes(unitEntry.unit);
    const incompatibleUnit = unitEntry && !validUnit;
    const selectedUnit = validUnit ? product.baseUnit : unitEntry ? null : null;
    let quantityMilli = quantity === null ? null : toMilli(quantity * (validUnit ? unitEntry.factor : 1));

    if (incompatibleUnit) {
      issues.push(makeIssue('invalid_unit', segment, `${product.name} does not use ${unitEntry.unit}. Choose a supported unit.`, product.id));
    }
    if (quantity !== null && quantity <= 0) {
      issues.push(makeIssue('invalid_quantity', segment, 'Quantity must be greater than zero.', product.id));
      quantityMilli = null;
    }

    let item = items.find((entry) => entry.productId === product.id);
    if (isCorrection && !item && (mode === 'correction' || correctionMarker)) {
      issues.push(makeIssue('missing_correction_target', segment, `This correction refers to ${product.name}, which is not in the order yet.`, product.id));
      item = null;
    }
    if (!item && !(isCorrection && (mode === 'correction' || correctionMarker))) {
      item = { productId: product.id, quantityMilli: null, unit: null };
      items.push(item);
    }

    if (item) {
      if (isCorrection) {
        item.quantityMilli = quantityMilli;
        item.unit = selectedUnit;
        if (quantityMilli !== null && selectedUnit && !incompatibleUnit) {
          issues = issues.filter((issue) => !(issue.productId === product.id && ['missing_quantity', 'missing_unit'].includes(issue.type)));
        }
      } else {
        if (quantityMilli !== null) item.quantityMilli = (item.quantityMilli ?? 0) + quantityMilli;
        if (selectedUnit) item.unit = selectedUnit;
      }
      if (quantity === null) issues.push(makeIssue('missing_quantity', segment, `How much ${product.name} should be added?`, product.id));
      if (!unitEntry) issues.push(makeIssue('missing_unit', segment, `Choose ${product.baseUnit} for ${product.name}, or say the unit.`, product.id));
    }
  }

  const completeItems = items.map((item) => {
    const product = CATALOG.find((entry) => entry.id === item.productId);
    if (!product || !Number.isInteger(item.quantityMilli) || item.quantityMilli <= 0 || item.unit !== product.baseUnit) {
      return { ...item, name: product?.name ?? item.productId, hindi: product?.hindi ?? item.productId, baseUnit: product?.baseUnit ?? '', unit: item.unit ?? null, pricePerBasePaise: product?.pricePerBasePaise ?? 0, lineTotalPaise: 0 };
    }
    return { ...item, name: product.name, hindi: product.hindi, baseUnit: product.baseUnit, pricePerBasePaise: product.pricePerBasePaise, lineTotalPaise: priceForQuantityPaise(product, item.quantityMilli) };
  });

  return { items: completeItems, issues, totalPaise: completeItems.reduce((sum, item) => sum + item.lineTotalPaise, 0) };
}

export function validateParsedOrder(parsed) {
  const incomplete = parsed.items.some((item) => !Number.isInteger(item.quantityMilli) || item.quantityMilli <= 0 || item.unit !== item.baseUnit);
  const unreviewed = parsed.issues.some((issue) => !issue.reviewed);
  return !incomplete && !unreviewed && parsed.items.length > 0;
}

// Shared by the correction UI and tests so both exercise the same application path.
export function applyCorrection(transcript, existingItems) {
  return parseOrder(transcript, existingItems, { mode: 'correction' });
}

// Used by the transcript-review screen before the order is first built.
export function parseSpokenOrder(transcript) {
  return parseOrder(transcript);
}

