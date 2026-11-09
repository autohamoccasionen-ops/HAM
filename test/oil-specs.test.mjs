import test from 'node:test';
import assert from 'node:assert/strict';
import {engineOilSpecification,approvedOilProduct} from '../oil-specs.mjs';
test('engine oil lookup derives manufacturer requirements from the vehicle record',()=>{
 assert.deepEqual(engineOilSpecification('Motoröl SAE 0W-20 MB 229.71 Alle Temperaturen'),{viscosity:'0W20',approval:'MB 229.71',query:'229.71'});
 assert.deepEqual(engineOilSpecification('Motor\nSAE 0W-20\nMB 229.71\nAlle Temperaturen'),{viscosity:'0W20',approval:'MB 229.71',query:'229.71'});
 assert.equal(engineOilSpecification('Motor\nSAE 0W-20\nACEA C5\nAlle Temperaturen'),null);
 assert.deepEqual(engineOilSpecification('Motoröl SAE 5W-30 VW 504 00 Alle Temperaturen'),{viscosity:'5W30',approval:'VW 504 00',query:'50400'});
 assert.equal(engineOilSpecification('Motoröl SAE 5W-30 ACEA C3 Alle Temperaturen'),null);
});
test('an oil alternative requires its own explicit approval, viscosity and one-litre package',()=>{
 const spec=engineOilSpecification('Motoröl SAE 5W-30 VW 504 00 Alle Temperaturen');
 const text='Motoröl 5W-30\nInhalt [Liter]: 1.000\nHerstellerfreigabe: VW 504.00';
 assert.equal(approvedOilProduct(text,spec),true);
 assert.equal(approvedOilProduct(text.replace('504.00','504.001'),spec),false);
 assert.equal(approvedOilProduct(text.replace('Herstellerfreigabe','Herstellerempfehlung'),spec),false);
 assert.equal(approvedOilProduct(text.replace('1.000','5.000'),spec),false);
 assert.equal(approvedOilProduct(text.replace('5W-30','0W-20'),spec),false);
});


test('a multiline preferred engine specification stays separate from alternatives and other fluids',()=>{
 const text='Motor ( außer Nordamerika)\nMotoröl (Bevorzugte Schmiermittelspezifikation)\nSAE 0W-30\nBMW Longlife-12 FE\nAlle Temperaturen\nMotoröl (Alternative Schmiermittelspezifikation)\nSAE 5W-30\nBMW Longlife-04\nAlle Temperaturen';
 assert.deepEqual(engineOilSpecification(text),{viscosity:'0W30',approval:'BMW Longlife-12 FE',query:'BMW Longlife-12 FE'});
 assert.equal(engineOilSpecification('Automatikgetriebeöl\nSAE 0W-30\nBMW Longlife-12 FE'),null);
});

test('unlabelled multiline engine lubricant rows retain their exact grade and manufacturer approval',()=>{
 const text='Motor\nMotoröl\nSAE 0W-30\nMB 229.5\nAlle Temperaturen\nMotoröl\nSAE 0W-30\nMB 229.3\nAlle Temperaturen';
 const spec=engineOilSpecification(text);
 assert.deepEqual(spec,{viscosity:'0W30',approval:'MB 229.5',query:'229.5'});
 assert.equal(approvedOilProduct('Motoröl 0W-30\nInhalt [Liter]: 1\nHerstellerfreigabe: MB 229.5',spec),true);
 assert.equal(approvedOilProduct('Motoröl 0W-30\nInhalt [Liter]: 1\nHerstellerempfehlung: MB 229.5',spec),false);
 assert.equal(engineOilSpecification('Automatikgetriebeöl\nSAE 0W-30\nMB 229.5'),null);
 assert.equal(engineOilSpecification('Motoröl\nSAE 0W-30\nACEA C3'),null);
});
