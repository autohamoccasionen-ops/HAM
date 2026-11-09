import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, retailPriceCents, parseOilCapacity, parseOilHours, calculateQuote } from '../quote.mjs';
import {vehicleServices} from '../vehicle-services.mjs';

test('wiper quote uses configured fifteen minutes and rejects another labour charge', () => {
  const name='Scheibenwischerblatt hinten';
  const input={...request,extras:[name]};
  const source={...verified,materials:[...verified.materials,{kind:'rear-wiper',partNumber:'TEST-WIPER',description:'Test rear wiper',quantity:1,unitNetCents:2000,priceBasis:'retail-ex-vat'}],
    extraLabour:[{service:name,...vehicleServices[name].garageLabour}]};
  const quote=calculateQuote(input,source);
  assert.equal(quote.serviceLines[0].hours,0.25);
  assert.equal(quote.serviceLines[0].labourNetCents,3750);
  assert.equal(quote.serviceLines[0].netCents,5750);
  assert.throws(()=>calculateQuote(input,{...source,extraLabour:[{...source.extraLabour[0],hours:0.5}]}),{code:'LABOUR_UNCONFIRMED'});
  assert.throws(()=>calculateQuote(input,{...source,materials:verified.materials}),{code:'MATERIAL_UNCONFIRMED'});
});

// Synthetic vehicle identifier; numerical fixture validates the calculation only.
// Tests only: never used as a production quote, cached price or VIN fallback.
const request = { vin: 'W0000000000000000', mileage: 115123, service: 'oel-service', extras: [] };
const verified = {
  vin: request.vin, vehicle: 'MERCEDES-BENZ V 300 d, OM 654.920', source: 'D-Store / HaynesPro',
  labourHours: 0.8, labourOperation: '00208001', materials: [
    { kind: 'oil', partNumber: '15F6E6', description: 'Castrol EDGE 0W-20 C5, MB 229.71', quantity: 9, unitNetCents: 3990, priceBasis: 'retail-ex-vat' },
    { kind: 'filter', partNumber: 'OX 823/6D', description: 'MAHLE Ölfilter mit Dichtung', quantity: 1, unitNetCents: 4320, priceBasis: 'retail-ex-vat' },
  ]
};

test('verified oil service: list prices, CHF 150/h, 8.1% VAT and upward CHF 0.05 rounding', () => {
  const quote = calculateQuote(validateRequest(request), verified, new Date('2026-11-07T10:00:00Z'));
  assert.equal(quote.materials[0].netCents, 35910);
  assert.equal(quote.labour.netCents, 12000);
  assert.equal(quote.subtotalNetCents, 52230);
  assert.equal(quote.vatCents, 4231);
  assert.equal(quote.roundingCents, 4);
  assert.equal(quote.totalCents, 56465);
  assert.deepEqual(quote.materials.map(row=>row.kind),['oil','filter']);
  assert.throws(()=>calculateQuote(request,{...verified,materials:[...verified.materials,
    {kind:'drain-plug',partNumber:'OLD-PLUG',description:'Excluded plug',quantity:1,unitNetCents:1346,priceBasis:'retail-ex-vat'}]}),
    {code:'MATERIAL_UNCONFIRMED'});
});

test('purchase and promotional prices never replace the retail list price', () => {
  assert.equal(retailPriceCents('UVPE:\n39.90 CHF\n21.62 CHF\nexkl. MwSt.'), 3990);
  assert.equal(retailPriceCents("UVPE: 2’394.00 CHF 686.00 CHF exkl. MwSt."), 239400);
  assert.throws(() => retailPriceCents('21.62 CHF exkl. MwSt.'), { code: 'PRICE_UNCONFIRMED' });
  assert.throws(() => retailPriceCents('UVPE: 43.13 CHF inkl. MwSt.'), { code: 'PRICE_UNCONFIRMED' });
});

test('HaynesPro combined operation is billed once', () => {
  assert.equal(parseOilHours('1C00501030WV0 Motoröl und Filter wechseln OE: 00208001 + 0,80'), 0.8);
  assert.equal(parseOilCapacity('! Ölwanne, einschließlich Filter 9.0 (l)'), 9);
  assert.throws(() => parseOilCapacity('Ölwanne, einschließlich Filter 9.0 (l)\nÖlwanne, einschließlich Filter 8.0 (l)'), { code: 'MANUAL_REVIEW_REQUIRED' });
  assert.throws(() => parseOilHours('Motoröl und Filter wechseln ohne bestätigte Zeit'), { code: 'LABOUR_UNCONFIRMED' });
});

test('reject mismatched VIN and incomplete or duplicate material selections', () => {
  assert.throws(() => calculateQuote(request, { ...verified, vin: 'X0000000000000000' }), { code: 'VEHICLE_UNCONFIRMED' });
  assert.throws(() => calculateQuote(request, { ...verified, materials: verified.materials.slice(0, 1) }), { code: 'MATERIAL_UNCONFIRMED' });
  assert.throws(() => calculateQuote(request, { ...verified, materials: [verified.materials[0], verified.materials[1], verified.materials[1]] }), { code: 'MATERIAL_UNCONFIRMED' });
});

test('reject missing prices instead of returning a zero-priced quote', () => {
  const materials = verified.materials.map(row => ({ ...row }));
  materials[0].unitNetCents = 0;
  assert.throws(() => calculateQuote(request, { ...verified, materials }), { code: 'MATERIAL_UNCONFIRMED' });
  materials[0].unitNetCents = 3990;
  materials[0].priceBasis = 'purchase';
  assert.throws(() => calculateQuote(request, { ...verified, materials }), { code: 'MATERIAL_UNCONFIRMED' });
});

test('validate customer inputs and require separate review of unsupported services', () => {
  assert.equal(validateRequest({ ...request, vin: 'w0000000000000000' }).vin, request.vin);
  assert.throws(() => validateRequest({ ...request, vin: '<script>' }), { code: 'INVALID_VIN' });
  assert.throws(() => validateRequest({ ...request, mileage: '115123' }), { code: 'INVALID_MILEAGE' });
  assert.throws(() => validateRequest({ ...request, extras: ['Bremsen'] }), { code: 'MANUAL_REVIEW_REQUIRED' });
  assert.throws(() => validateRequest({ ...request, service: 'getriebeoel-service' }), { code: 'MANUAL_REVIEW_REQUIRED' });
});

test('selected packages are itemized once and VAT is calculated on the complete quotation',()=>{
 const input=validateRequest({...request,extras:['Kraftstoffadditiv Diesel','Bremsflüssigkeit wechseln']});
 const result=calculateQuote(input,verified);
 assert.equal(result.baseSubtotalNetCents,52230);
 assert.equal(result.subtotalNetCents,66030);
 assert.equal(result.totalCents,71380);
 assert.equal(result.labour.netCents,12000);
 assert.deepEqual(result.addOns.map(x=>x.netCents),[11000,2800]);
});

test('conflicts and unsupported parts never receive a made-up package price',()=>{
 for(const extras of [['Reifenwechsel','Räderwechsel'],['Aussenreinigung ohne Politur','Aussenreinigung mit Politur'],['Bremsflüssigkeit wechseln','Bremsflüssigkeit wechseln'],['Reifendrucksensoren erneuern'],['Räder reinigen']])
  assert.throws(()=>validateRequest({...request,extras}),{code:'INVALID_REQUEST'});
 assert.throws(()=>calculateQuote(validateRequest({...request,extras:['Bremsbeläge Vorderachse erneuern']}),verified),{code:'MATERIAL_UNCONFIRMED'});
 const result=calculateQuote(validateRequest({...request,extras:['Reifenwechsel','Reifendrucksensoren erneuern']}),verified);
 assert.equal(result.addOns.find(x=>x.name==='Reifendrucksensoren erneuern').netCents,28000);
});

test('vehicle-specific brake materials and labour are required and charged once',()=>{
 const service='Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern';
 const input=validateRequest({...request,extras:[service]});
 const source={...verified,materials:[...verified.materials,
  {kind:'front-discs',partNumber:'TEST-DISC',description:'Test disc',quantity:2,unitNetCents:10000,priceBasis:'retail-ex-vat'},
  {kind:'front-pads',partNumber:'TEST-PADS',description:'Test pad set',quantity:1,unitNetCents:8000,priceBasis:'retail-ex-vat'}],
  extraLabour:[{service,operation:'test-disc-operation',hours:1}]};
 const quote=calculateQuote(input,source);
 assert.equal(quote.materials.length,4);assert.equal(quote.labour.hours,1.8);
 assert.equal(quote.subtotalNetCents,95230);
 assert.equal(quote.baseOilSubtotalNetCents,52230);assert.equal(quote.serviceLines[0].netCents,43000);
 assert.throws(()=>calculateQuote(input,{...source,extraLabour:[]}),{code:'LABOUR_UNCONFIRMED'});
 assert.throws(()=>validateRequest({...input,extras:[service,'Bremsbeläge Vorderachse erneuern']}),{code:'INVALID_REQUEST'});
});

