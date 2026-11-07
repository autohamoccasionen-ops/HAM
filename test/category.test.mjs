import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryCheckboxState, uniqueCheckboxChange, normalizeCatalogText, oilPackageConfirmed } from '../browser-provider.mjs';

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
  assert.equal(normalizeCatalogText('Bremsscheibe',['ATE LOGO','VIN']),'Bremsscheibe\nATE\nVIN');
  assert.equal(normalizeCatalogText('Bremsscheibe',['ATE','TRW']),'Bremsscheibe');
});

test('oil package validation distinguishes 1 litre from 1.5 and 5 litres and rejects another viscosity', () => {
  assert.equal(oilPackageConfirmed('0W-20\nInhalt [Liter]: 1.000'), true);
  assert.equal(oilPackageConfirmed('0W20\nInhalt [Liter]: 1,0'), true);
  assert.equal(oilPackageConfirmed('0W20\nInhalt [Liter]: 1.5'), false);
  assert.equal(oilPackageConfirmed('0W20\nInhalt [Liter]: 5'), false);
  assert.equal(oilPackageConfirmed('0W-30\nInhalt [Liter]: 1'), false);
});
