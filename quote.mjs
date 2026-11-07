export class QuoteError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new QuoteError('INVALID_REQUEST', 'Ungültige Anfrage.', 400);
  }
  const vin = typeof input.vin === 'string' ? input.vin.trim().toUpperCase().replace(/\s/g, '') : '';
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    throw new QuoteError('INVALID_VIN', 'Bitte eine gültige 17-stellige Fahrgestellnummer eingeben.', 400);
  }
  if (!Number.isSafeInteger(input.mileage) || input.mileage < 0 || input.mileage > 9999999) {
    throw new QuoteError('INVALID_MILEAGE', 'Bitte den Kilometerstand als ganze Zahl eingeben.', 400);
  }
  if (input.service !== 'oel-service' || (input.extras && (!Array.isArray(input.extras) || input.extras.length))) {
    throw new QuoteError('MANUAL_REVIEW_REQUIRED', 'Diese Auswahl wird individuell durch die Garage kalkuliert.');
  }
  return { vin, mileage: input.mileage, service: 'oel-service', extras: [] };
}

export function moneyCents(text) {
  const clean = String(text).replace(/[’'\s]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) {
    throw new QuoteError('PRICE_UNCONFIRMED', 'Der Listenpreis konnte nicht eindeutig gelesen werden.');
  }
  const amount = Math.round(Number(clean) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10000000) {
    throw new QuoteError('PRICE_UNCONFIRMED', 'Der Listenpreis liegt ausserhalb des zulässigen Bereichs.');
  }
  return amount;
}

// Only UVPE / recommended retail price excluding VAT is accepted.
// The customer's purchase price, promotional purchase price and gross price
// including VAT must never be substituted for this value.
export function retailPriceCents(text) {
  const match = String(text).match(/UVPE\s*:\s*([\d’'.,\s]+?)\s*CHF[\s\S]*?exkl\.\s*MwSt\./i);
  if (!match) throw new QuoteError('PRICE_UNCONFIRMED', 'Listenpreis ohne MwSt. nicht bestätigt.');
  return moneyCents(match[1]);
}

export function parseOilCapacity(text) {
  const matches = [...String(text).matchAll(/Ölwanne,\s*einschlie(?:ß|ss)lich Filter\s+(\d+(?:[.,]\d+)?)\s*\(l\)/g)];
  if (matches.length !== 1) throw new QuoteError('MANUAL_REVIEW_REQUIRED', 'Ölfüllmenge nicht eindeutig bestimmt.');
  const litres = Number(matches[0][1].replace(',', '.'));
  if (!Number.isFinite(litres) || litres < 2 || litres > 20) throw new QuoteError('MANUAL_REVIEW_REQUIRED', 'Ölfüllmenge muss geprüft werden.');
  return litres;
}

export function parseOilHours(text) {
  const match = String(text).match(/Motoröl und Filter wechseln\s*(?:OE\s*:\s*[\w-]+\s*\+?\s*)?(\d+[.,]\d{2})/i);
  if (!match) throw new QuoteError('LABOUR_UNCONFIRMED', 'Arbeitszeit für Motoröl und Filter nicht bestätigt.');
  const hours = Number(match[1].replace(',', '.'));
  if (hours <= 0 || hours > 3) throw new QuoteError('LABOUR_UNCONFIRMED', 'Arbeitszeit muss geprüft werden.');
  return hours;
}

export function calculateQuote(request, source, now = new Date()) {
  if (source.vin !== request.vin || !source.vehicle || source.source !== 'D-Store / HaynesPro') {
    throw new QuoteError('VEHICLE_UNCONFIRMED', 'Fahrzeugzuordnung nicht bestätigt.');
  }
  if (!Array.isArray(source.materials) || source.materials.length !== 3 ||
      new Set(source.materials.map(row => row.kind)).size !== 3 ||
      !['oil', 'filter', 'drain-plug'].every(kind => source.materials.some(row => row.kind === kind))) {
    throw new QuoteError('MATERIAL_UNCONFIRMED', 'Materialauswahl unvollständig.');
  }
  const materialLines = source.materials.map(row => {
    if (!row.partNumber || !row.description || !Number.isSafeInteger(row.unitNetCents) || row.unitNetCents <= 0 ||
        !Number.isFinite(row.quantity) || row.quantity <= 0 || row.quantity > 20 || row.priceBasis !== 'retail-ex-vat') {
      throw new QuoteError('MATERIAL_UNCONFIRMED', 'Materialmenge oder Verkaufspreis nicht bestätigt.');
    }
    return { kind: row.kind, partNumber: row.partNumber, description: row.description, quantity: row.quantity,
      unit: row.kind === 'oil' ? 'l' : 'Stück', unitNetCents: row.unitNetCents,
      netCents: Math.round(row.unitNetCents * row.quantity) };
  });
  const hours = source.labourHours;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 3 || !source.labourOperation) {
    throw new QuoteError('LABOUR_UNCONFIRMED', 'Arbeitszeit nicht bestätigt.');
  }
  const labour = { description: 'Motoröl und Filter wechseln', operation: source.labourOperation,
    hours, hourlyRateNetCents: 15000, netCents: Math.round(hours * 15000) };
  const subtotalNetCents = materialLines.reduce((sum, row) => sum + row.netCents, labour.netCents);
  const vatCents = Math.round(subtotalNetCents * 81 / 1000);
  const totalCents = Math.ceil((subtotalNetCents + vatCents) / 5) * 5;
  return { status: 'quoted', currency: 'CHF', vin: request.vin, mileage: request.mileage,
    service: request.service, vehicle: source.vehicle, materials: materialLines, labour,
    subtotalNetCents, vatRate: 0.081, vatCents,
    roundingCents: totalCents - subtotalNetCents - vatCents, totalCents,
    source: source.source, retrievedAt: now.toISOString() };
}
