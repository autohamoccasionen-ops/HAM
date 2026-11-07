import { vehicleServices,serviceComponents } from './vehicle-services.mjs';
export class QuoteError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Existing garage package prices, excluding VAT. These include their own
// labour and must not receive another hourly labour charge.
export const extraPackages = Object.freeze({
  'Bremsflüssigkeit wechseln':11000,
  'Batterie der Schlüsselfernbedienung ersetzen':990,
  'Aussenreinigung ohne Politur':15000,'Aussenreinigung mit Politur':35000,
  'Chassisreinigung inklusive Motorraum':12000,'Innenreinigung':15000,
  'Kraftstoffadditiv Benzin':2800,'Kraftstoffadditiv Diesel':2800,
  'Klimaanlage desinfizieren':3990,'Klimaservice R134a':12000,
  'Reifenwechsel':14000,'Räderwechsel':8000,'Räder auswuchten':8000,
  'Reifen bei uns einlagern':5000,'Räder bei uns einlagern':5000,
  'Räder reinigen':2500,'Reifendruck-Gummi-Ventile erneuern':1000,
  'Reifendrucksensoren erneuern':36000
});

export function selectedExtraPackages(values = []) {
  if (!Array.isArray(values) || values.length > 30 || values.some(x => typeof x !== 'string' || (!Object.hasOwn(extraPackages,x)&&!Object.hasOwn(vehicleServices,x))))
    throw new QuoteError('MANUAL_REVIEW_REQUIRED', 'Für mindestens eine gewählte Zusatzleistung müssen Material und Arbeitszeit noch individuell geprüft werden.');
  if (new Set(values).size !== values.length) throw new QuoteError('INVALID_REQUEST','Eine Zusatzleistung wurde mehrfach übermittelt.',400);
  const conflict = names => names.filter(x => values.includes(x)).length > 1;
  if (conflict(['Reifenwechsel','Räderwechsel','Räder auswuchten'])
    || conflict(['Aussenreinigung ohne Politur','Aussenreinigung mit Politur'])
    || conflict(['Reifendrucksensoren erneuern','Reifendruck-Gummi-Ventile erneuern'])
    || conflict(['Kraftstoffadditiv Benzin','Kraftstoffadditiv Diesel'])
    || conflict(['Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern','Bremsbeläge Vorderachse erneuern'])
    || conflict(['Bremsscheiben inkl. Bremsbeläge Hinterachse erneuern','Bremsbeläge Hinterachse erneuern']))
    throw new QuoteError('INVALID_REQUEST','Bitte prüfen Sie die Kombination Ihrer Zusatzleistungen.',400);
  if ((values.includes('Reifen bei uns einlagern') || values.includes('Reifendruck-Gummi-Ventile erneuern') || values.includes('Reifendrucksensoren erneuern')) && !values.includes('Reifenwechsel'))
    throw new QuoteError('INVALID_REQUEST','Diese Zusatzleistung erfordert einen Reifenwechsel.',400);
  if (values.includes('Räder bei uns einlagern') && !values.includes('Räderwechsel')) throw new QuoteError('INVALID_REQUEST','Die Räder-Einlagerung erfordert einen Räderwechsel.',400);
  if (values.includes('Räder reinigen') && !values.includes('Räder bei uns einlagern')) throw new QuoteError('INVALID_REQUEST','Die Räderreinigung erfordert die gewählte Einlagerung.',400);
  return [...values].sort().filter(name=>Object.hasOwn(extraPackages,name)).map(name => ({name,netCents:name==='Reifendrucksensoren erneuern'&&values.includes('Reifenwechsel')?28000:extraPackages[name],priceBasis:'garage-package'}));
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
  if (input.service !== 'oel-service') {
    throw new QuoteError('MANUAL_REVIEW_REQUIRED', 'Diese Auswahl wird individuell durch die Garage kalkuliert.');
  }
  selectedExtraPackages(input.extras ?? []);
  const extras=[...(input.extras??[])].sort();
  return { vin, mileage: input.mileage, service: 'oel-service', extras };
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
  const vehicleExtraNames=(request.extras||[]).filter(name=>Object.hasOwn(vehicleServices,name));
  const requiredKinds=['oil','filter','drain-plug',...serviceComponents(vehicleExtraNames).map(x=>x.kind)];
  if (!Array.isArray(source.materials) || source.materials.length !== requiredKinds.length ||
      new Set(source.materials.map(row => row.kind)).size !== requiredKinds.length ||
      !requiredKinds.every(kind => source.materials.some(row => row.kind === kind))) {
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
  const extraLabour=source.extraLabour||[];
  if(extraLabour.length!==vehicleExtraNames.length||new Set(extraLabour.map(x=>x.service)).size!==vehicleExtraNames.length
    || !vehicleExtraNames.every(name=>extraLabour.some(x=>x.service===name&&x.operation&&Number.isFinite(x.hours)&&x.hours>0&&x.hours<=12))
    || new Set([source.labourOperation,...extraLabour.map(x=>x.operation)]).size!==1+extraLabour.length)
    throw new QuoteError('LABOUR_UNCONFIRMED','Arbeitspositionen müssen eindeutig und ohne Überschneidung bestätigt werden.');
  if(!Number.isFinite(source.labourHours)||source.labourHours<=0||source.labourHours>3)
    throw new QuoteError('LABOUR_UNCONFIRMED','Arbeitszeit für den Motoröl-Service nicht bestätigt.');
  const hours = source.labourHours+extraLabour.reduce((sum,x)=>sum+x.hours,0);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 30 || !source.labourOperation) {
    throw new QuoteError('LABOUR_UNCONFIRMED', 'Arbeitszeit nicht bestätigt.');
  }
  const labour = { description: extraLabour.length?'Motoröl-Service und ausgewählte Zusatzleistungen':'Motoröl und Filter wechseln', operation: source.labourOperation,
    hours, hourlyRateNetCents: 15000, netCents: Math.round(hours * 15000) };
  const addOns = selectedExtraPackages(request.extras);
  const baseSubtotalNetCents = materialLines.reduce((sum, row) => sum + row.netCents, labour.netCents);
  const serviceLines=vehicleExtraNames.map(name=>{
    const kinds=vehicleServices[name].components.map(x=>x.kind);
    const materialNetCents=materialLines.filter(x=>kinds.includes(x.kind)).reduce((sum,x)=>sum+x.netCents,0);
    const evidence=extraLabour.find(x=>x.service===name);
    const labourNetCents=Math.round(evidence.hours*15000);
    return {name,hours:evidence.hours,materialNetCents,labourNetCents,netCents:materialNetCents+labourNetCents};
  });
  const baseOilSubtotalNetCents=baseSubtotalNetCents-serviceLines.reduce((sum,x)=>sum+x.netCents,0);
  const subtotalNetCents = addOns.reduce((sum,row)=>sum+row.netCents,baseSubtotalNetCents);
  const vatCents = Math.round(subtotalNetCents * 81 / 1000);
  const totalCents = Math.ceil((subtotalNetCents + vatCents) / 5) * 5;
  return { status: 'quoted', currency: 'CHF', vin: request.vin, mileage: request.mileage,
    service: request.service, vehicle: source.vehicle, materials: materialLines, labour,
    baseSubtotalNetCents,baseOilSubtotalNetCents,serviceLines, addOns, extras:[...(request.extras||[])].sort(), subtotalNetCents, vatRate: 0.081, vatCents,
    roundingCents: totalCents - subtotalNetCents - vatCents, totalCents,
    source: source.source, retrievedAt: now.toISOString() };
}
