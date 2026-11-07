import test from 'node:test';
import assert from 'node:assert/strict';
import {vehicleServices,componentCandidate,operationEvidence} from '../vehicle-services.mjs';
import {retailPriceCents} from '../quote.mjs';
test('brake candidates require VIN fitment, exact axle and correct axle quantity',()=>{
 const c=vehicleServices['Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern'].components[0];
 const text='Artikel Nr.: TEST-DISC\nATE\nBremsscheibe\nVIN\nEinbauseite: Vorderachse\nbenötigte Stückzahl: 2\nUVPE: 100.00 CHF 60.00 CHF exkl. MwSt.';
 assert.equal(componentCandidate(text,c,retailPriceCents).quantity,2);
 assert.equal(componentCandidate(text.replace('Vorderachse','Hinterachse'),c,retailPriceCents),null);
 assert.equal(componentCandidate(text.replace('Stückzahl: 2','Stückzahl: 1'),c,retailPriceCents),null);
 assert.equal(componentCandidate(text.replace('VIN',''),c,retailPriceCents),null);
});
test('operation matching retains axle distinction and refuses ambiguous times',()=>{
 const names=vehicleServices['Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern'].operations;
 const text='Beide Bremsscheiben erneuern (Vorderachse) OE: 42273101 + 1,00';
 assert.deepEqual(operationEvidence(text,names),{operation:'42273101',hours:1});
 assert.equal(operationEvidence(text.replace('Vorderachse','Hinterachse'),names),null);
 assert.equal(operationEvidence(text+'\n'+text.replace('1,00','1,50'),names),null);
});
