import test from 'node:test';
import assert from 'node:assert/strict';
import {vehicleServices,componentCandidate,operationEvidence,catalogBrand,uniqueOeVariant} from '../vehicle-services.mjs';
import {retailPriceCents} from '../quote.mjs';
test('brake candidates require VIN fitment, exact axle and correct axle quantity',()=>{
 const c=vehicleServices['Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern'].components[0];
 const text='Artikel Nr.: TEST-DISC\nATE\nBremsscheibe\nVIN\nEinbauseite: Vorderachse\nbenötigte Stückzahl: 2\nUVPE: 100.00 CHF 60.00 CHF exkl. MwSt.';
 assert.equal(componentCandidate(text,c,retailPriceCents).quantity,2);
 assert.equal(componentCandidate(text.replace('Vorderachse','Hinterachse'),c,retailPriceCents),null);
 assert.equal(componentCandidate(text.replace('Stückzahl: 2','Stückzahl: 1'),c,retailPriceCents),null);
 assert.equal(componentCandidate(text.replace('VIN',''),c,retailPriceCents),null);
 assert.equal(componentCandidate(text.replace('Bremsscheibe','Schraube, Bremsscheibe'),c,retailPriceCents),null);
 const pads=vehicleServices['Bremsbeläge Vorderachse erneuern'].components[0];
 assert.equal(componentCandidate(text.replace('Bremsscheibe','Warnkontakt, Bremsbelagverschleiß').replace('Stückzahl: 2','Stückzahl: 1'),pads,retailPriceCents),null);
 const noSide=text.replace('Einbauseite: Vorderachse\n','');
 assert.equal(componentCandidate(noSide,c,retailPriceCents),null);
 assert.equal(componentCandidate(noSide,c,retailPriceCents,{confirmed:true,axle:'front'}).quantity,2);
 assert.equal(componentCandidate(text.replace('Vorderachse','Hinterachse'),c,retailPriceCents,{confirmed:true,axle:'front'}),null);
 assert.equal(componentCandidate(text.replace('Einbauseite','Standort').replace('Vorderachse','Hinterachse'),c,retailPriceCents,{confirmed:true,axle:'front'}),null);
 assert.equal(componentCandidate(text.replace('Einbauseite','Standort'),c,retailPriceCents).quantity,2);
 assert.equal(componentCandidate(text.replace('Einbauseite','Einbauposition').replace('Vorderachse','Hinterachse'),c,retailPriceCents,{confirmed:true,axle:'front'}),null);
});
test('only one explicitly identified OE-equivalent product line resolves an optional upgrade',()=>{
 const prime={brand:'BREMBO',productLine:'Prime',partNumber:'TEST-STANDARD',unitNetCents:20000};
 const upgrade={brand:'BREMBO',productLine:null,partNumber:'TEST-UPGRADE',unitNetCents:10000};
 assert.equal(uniqueOeVariant([prime,upgrade]),prime);
 assert.equal(uniqueOeVariant([prime,{...prime,partNumber:'TEST-OTHER-FITMENT'}]),null);
 assert.equal(uniqueOeVariant([upgrade]),null);
 assert.equal(uniqueOeVariant([prime,{...upgrade,brand:'ATE'}]),null);
});
test('manufacturer evidence is not confused with a brake system compatibility label',()=>{
 const text='Herstellereinschränkung: ATE\nKatalog-Marke: BREMBO';
 assert.equal(catalogBrand(text,['ATE','BREMBO']), 'BREMBO');
 assert.equal(catalogBrand('Herstellereinschränkung: ATE',['ATE','BREMBO']), null);
 const battery=vehicleServices['Starterbatterie ersetzen'].components[0];
 const card='Artikel Nr.: TEST-BATTERY\nStarterbatterie\nVIN\nbenötigte Stückzahl: 1\nUVPE: 200.00 CHF 100.00 CHF exkl. MwSt.\nKatalog-Marke: VARTA';
 assert.equal(componentCandidate(card,battery,retailPriceCents).brand,'VARTA');
 assert.equal(componentCandidate(card.replace('Stückzahl: 1','Stückzahl: 2'),battery,retailPriceCents),null);
});
test('front wiper service requires evidence of a complete set',()=>{
 const component=vehicleServices['Scheibenwischerblätter vorne wechseln'].components[0];
 const card='Artikel Nr.: TEST-WIPER\nWischblatt\nVIN\nEinbauseite: vorne\nbenötigte Stückzahl: 1\nUVPE: 50.00 CHF 20.00 CHF exkl. MwSt.\nKatalog-Marke: BOSCH';
 assert.equal(componentCandidate(card,component,retailPriceCents),null);
 assert.equal(componentCandidate(card+'\nMenge: 2',component,retailPriceCents).quantity,1);
});
test('one complete axle pad set may contain multiple pads while disc pack pricing stays guarded',()=>{
 const c=vehicleServices['Bremsbeläge Vorderachse erneuern'].components[0];
 const text='Artikel Nr.: TEST-PAD-SET\nBremsbelagsatz\nVIN\nbenötigte Stückzahl: 1\n4 Stück = 1 Pack\nUVPE: 120.00 CHF 80.00 CHF exkl. MwSt.\nKatalog-Marke: FERODO';
 assert.equal(componentCandidate(text,c,retailPriceCents,{confirmed:true,axle:'front'}).quantity,1);
 assert.equal(componentCandidate(text.replace('Bremsbelagsatz','Einzelner Bremsbelag'),c,retailPriceCents,{confirmed:true,axle:'front'}),null);
});
test('operation matching retains axle distinction and refuses ambiguous times',()=>{
 const names=vehicleServices['Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern'].operations;
 const text='Beide Bremsscheiben erneuern (Vorderachse) OE: 42273101 + 1,00';
 assert.deepEqual(operationEvidence(text,names),{operation:'42273101',hours:1});
 assert.equal(operationEvidence(text.replace('Vorderachse','Hinterachse'),names),null);
 assert.equal(operationEvidence(text+'\n'+text.replace('1,00','1,50'),names),null);
});
