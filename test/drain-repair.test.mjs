import test from 'node:test';
import assert from 'node:assert/strict';
import { drainPlugRepairNumbers, replacementDrainPlug } from '../browser-provider.mjs';

const original='Artikel Nr.: PLUG-A\nELRING\nVIN\nVerschlussschraube, Ölwanne\n'
  +'benötigte Stückzahl:\n1\nErgänzungsartikel/Ergänzende Info:\nohne Dichtring\n'
  +'Gewindemaß:\nM14x1,5x33\nalternativer Reparatursatz:\nKIT-A, KIT-B';
const kit='Artikel Nr.: KIT-A\nELRING\nVerschlussschraube, Ölwanne\n'
  +'Ergänzungsartikel/Ergänzende Info: mit Dichtring | Gewindemaß: M14x1,5x33\n'
  +'UVPE: 4.15 CHF exkl. MwSt.';

test('a declared repair kit retains exact VIN plug fitment, thread, manufacturer and live retail price',()=>{
  assert.deepEqual(drainPlugRepairNumbers(original),['KIT-A','KIT-B']);
  const part=replacementDrainPlug(original,kit,'KIT-A');
  assert.equal(part.partNumber,'KIT-A');
  assert.equal(part.quantity,1);
  assert.equal(part.unitNetCents,415);
  assert.equal(part.kind,'drain-plug');
});

test('ELRING decimal-comma references remain complete article numbers',()=>{
  const numeric=original.replace('PLUG-A','123.456').replace('KIT-A, KIT-B','505,540');
  assert.deepEqual(drainPlugRepairNumbers(numeric),['505.540']);
  assert.deepEqual(drainPlugRepairNumbers(numeric.replace('505,540','505,540, 877,840')),['505.540','877.840']);
  assert.deepEqual(drainPlugRepairNumbers(numeric.replace('505,540','505.540; 877.840')),['505.540','877.840']);
  assert.equal(replacementDrainPlug(numeric,kit.replace('KIT-A','505.540'),'505.540').partNumber,'505.540');
});

test('unrelated, unsealed, different-thread, different-brand and multi-pack plugs cannot become repair kits',()=>{
  for(const alternative of [kit.replace('mit Dichtring','ohne Dichtring'),kit.replace('M14x1,5x33','M14x1,5x25'),
    kit.replace('ELRING','FEBI BILSTEIN'),kit+'\n5 Stück = 1 Pack',kit+'\nbenötigte Stückzahl: 2'])
    assert.equal(replacementDrainPlug(original,alternative,'KIT-A'),null);
  assert.equal(replacementDrainPlug(original,kit,'UNLISTED'),null);
  assert.deepEqual(drainPlugRepairNumbers(original.replace('VIN','')),[]);
  assert.deepEqual(drainPlugRepairNumbers(original.replace('Stückzahl:\n1','Stückzahl:\n2')),[]);
  assert.equal(replacementDrainPlug(original.replace('M14x1,5x33','M14'),kit,'KIT-A'),null);
  assert.throws(()=>replacementDrainPlug(original,kit.replace('UVPE:','EK:'),'KIT-A'),{code:'PRICE_UNCONFIRMED'});
});
