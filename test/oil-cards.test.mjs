import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseApprovedEngineOil } from '../browser-provider.mjs';

test('oil selection waits for loaded cards and opens hidden details on the visible product container',async()=>{
 let loaded=0,opened=false,query;
 const text=()=> 'Artikel Nr.: TEST-OIL\nMOBIL\nMotoröl SAE 0W-30\nUVPE: 39.90 CHF 21.62 CHF exkl. MwSt.'
  +(opened?'\nInhalt [Liter]: 1.000\nHerstellerfreigabe: MB 229.5':'\nMehr Details');
 const node={get innerText(){return text()},querySelectorAll:()=>[]};
 const details={filter(){return this},count:async()=>1,click:async()=>{opened=true}};
 const article={evaluate:async fn=>fn(node),filter(){return this},waitFor:async()=>{},
  getByRole:()=>details,getByText:()=>({first:()=>({waitFor:async()=>{}})})};
 const page={getByRole:()=>({fill:async value=>{query=value},press:async()=>{}}),
  getByText:()=>({waitFor:async()=>{}}),waitForTimeout:async()=>{},
  locator:()=>({first:()=>({waitFor:async()=>{}}),locator:()=>article,isVisible:async()=>false}),
  evaluate:async()=>++loaded===1?[]:[{id:'part-detail-oil',depth:1,text:text(),labels:[],imageLabels:[]}]};
 const result=await chooseApprovedEngineOil(page,{approval:'MB 229.5',viscosity:'0W30',query:'229.5'});
 assert.equal(query,'229.5 0W-30');assert.ok(loaded>=2);assert.equal(opened,true);
 assert.equal(result.partNumber,'TEST-OIL');assert.equal(result.unitNetCents,3990);
});
