import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryCheckboxState, uniqueCheckboxChange, normalizeCatalogText, oilPackageConfirmed, requestedProductsPresent, waitForArticle, waitForVin, vehicleIdFromUrl } from '../browser-provider.mjs';

test('only an actual vehicle route supplies the catalogue vehicle identifier',()=>{
  assert.equal(vehicleIdFromUrl('https://supplier.test/dch-ax/vehicle/V123M456'), '123');
  assert.equal(vehicleIdFromUrl('https://supplier.test/dch-ax/vehicle/V123M456/parts?tab=quick'), '123');
  assert.equal(vehicleIdFromUrl('https://supplier.test/dch-ax/home?vehicle=V123M456'), null);
  assert.equal(vehicleIdFromUrl('https://supplier.test/dch-ax/vehicle/unknown'), null);
});

test('supplier VIN outage stops immediately even when an old vehicle label remains', async () => {
  let confirmedWaits=0;
  const unavailable={isVisible:async()=>true};
  const confirmed={waitFor:async()=>{confirmedWaits++}};
  const page={getByRole:()=>({or:()=>({first:()=>({waitFor:async()=>{}})})}),
    getByText:(text)=>text==='VIN-Suche vorübergehend nicht verfügbar'?unavailable:{first:()=>confirmed}};
  await assert.rejects(()=>waitForVin(page,'W0000000000000000'),{code:'SOURCE_UNAVAILABLE',status:503});
  assert.equal(confirmedWaits,0);
});

test('oil lookup waits for the exact article in its complete visible card', async () => {
  const previous=globalThis.document;
  const card=(number,visible=true)=>{
    const root={innerText:'Artikel Nr.: '+number+'\nMotoröl',querySelectorAll:()=>[node]};
    const node={innerText:'Details',parentElement:root,getBoundingClientRect:()=>({height:visible?20:0})};
    return node;
  };
  try {
    const page={waitForFunction:async(predicate,number)=>{
      for(const nodes of [[card('OLD-FILTER')],[card('15F6E60')],[card(number,false)]]){
        globalThis.document={querySelectorAll:()=>nodes};
        assert.equal(predicate(number),false);
      }
      globalThis.document={querySelectorAll:()=>[card(number)]};
      assert.equal(predicate(number),true);
    }};
    await waitForArticle(page,'15F6E6');
  } finally {if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('combined brake work waits for both discs and pads instead of the first matching product',()=>{
  const components=[{product:'^Bremsscheibe\\b'},{product:'^Bremsbelagsatz\\b'}];
  const pads={text:'Bremsbelagsatz, Scheibenbremse'};
  assert.equal(requestedProductsPresent([pads],components),false);
  assert.equal(requestedProductsPresent([pads,{text:'Bremsscheibe'}],components),true);
  assert.equal(requestedProductsPresent([{text:'Zubehörsatz, Bremsbelag'}],components),false);
  assert.equal(requestedProductsPresent([],[]),false);
});

test('category selection supports native and ARIA checkboxes without guessing unknown state', () => {
  for (const checked of [true, false]) {
    assert.equal(categoryCheckboxState({ type: 'checkbox', checked }), checked);
    assert.equal(categoryCheckboxState({ querySelector: () => ({ checked }) }), checked);
    assert.equal(categoryCheckboxState({ getAttribute: () => String(checked) }), checked);
  }
  assert.equal(categoryCheckboxState({ getAttribute: () => 'mixed' }), null);
  assert.equal(categoryCheckboxState({ getAttribute: () => null }), null);
});

test('an ambiguous row is resolved only by one changed control with stable identity', () => {
  const before = [{ id: 'a', checked: false }, { id: 'b', checked: false }];
  assert.equal(uniqueCheckboxChange(before, [{ id: 'a', checked: false }, { id: 'b', checked: true }]), 1);
  assert.equal(uniqueCheckboxChange(before, [{ id: 'a', checked: true }, { id: 'b', checked: true }]), null);
  assert.equal(uniqueCheckboxChange(before, [...before].reverse()), null);
  assert.equal(uniqueCheckboxChange(before, before), null);
  assert.equal(uniqueCheckboxChange([{ id: null, checked: false }], [{ id: null, checked: true }]), null);
});

test('catalog image labels add only unambiguous brands and explicit VIN badges', () => {
  const text = normalizeCatalogText('Oelfilter', ['MAHLE', 'VIN']);
  assert.ok(text.includes('Ölfilter'));
  assert.ok(text.includes('MAHLE'));
  assert.ok(text.includes('VIN'));
  assert.equal(normalizeCatalogText('Oelfilter', ['MAHLE', 'BOSCH', 'Keine VIN-Prüfung']), 'Ölfilter');
  assert.equal(normalizeCatalogText('Bremsscheibe',['ATE LOGO','VIN']),'Bremsscheibe\nATE\nKatalog-Marke: ATE\nVIN');
  assert.equal(normalizeCatalogText('Bremsscheibe',['ATE','TRW']),'Bremsscheibe');
});

test('oil package validation distinguishes 1 litre from 1.5 and 5 litres and rejects another viscosity', () => {
  assert.equal(oilPackageConfirmed('0W-20\nInhalt [Liter]: 1.000'), true);
  assert.equal(oilPackageConfirmed('0W20\nInhalt [Liter]: 1,0'), true);
  assert.equal(oilPackageConfirmed('0W20\nInhalt [Liter]: 1.5'), false);
  assert.equal(oilPackageConfirmed('0W20\nInhalt [Liter]: 5'), false);
  assert.equal(oilPackageConfirmed('0W-30\nInhalt [Liter]: 1'), false);
});

