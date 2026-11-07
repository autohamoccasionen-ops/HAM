// Lookup candidates must match the live D-Store and HaynesPro evidence.
// A definition is a lookup rule, never a cached part, price or labour time.
const brake = (axle, discs) => ({
  category:'Scheibenbremse', categoryAxle:axle,
  components:[...(discs?[{kind:axle+'-discs',name:'Bremsscheiben '+(axle==='front'?'Vorderachse':'Hinterachse'),product:'(?:^|\\n)\\s*Bremsscheiben?\\b',axle}]:[]),
    {kind:axle+'-pads',name:'Bremsbeläge '+(axle==='front'?'Vorderachse':'Hinterachse'),product:'(?:^|\\n)\\s*Bremsbel(?:agsatz|ag|äge)\\b',axle}],
  operations:[discs?`Beide Bremsscheiben erneuern (${axle==='front'?'Vorderachse':'Hinterachse'})`:`Bremsbeläge erneuern (${axle==='front'?'Vorderachse':'Hinterachse'})`]
});
export const vehicleServices=Object.freeze({
  'Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern':brake('front',true),
  'Bremsbeläge Vorderachse erneuern':brake('front',false),
  'Bremsscheiben inkl. Bremsbeläge Hinterachse erneuern':brake('rear',true),
  'Bremsbeläge Hinterachse erneuern':brake('rear',false),
  'Luftfilter-Wechsel':{category:'Luftfilter',components:[{kind:'air-filter',name:'Luftfilter',product:'\\bLuftfilter\\b'}],operations:['Luftfilter erneuern','Luftfilter wechseln']},
  'Pollenfilter-Wechsel':{category:'Innenraumfilter',components:[{kind:'cabin-filter',name:'Pollenfilter',product:'Innenraumluft|Innenraumfilter|Pollenfilter'}],operations:['Innenraumfilter erneuern','Innenraumluftfilter erneuern','Pollenfilter erneuern','Filter für Innenraumluft erneuern']},
  'Kraftstofffilter wechseln':{category:'Kraftstofffilter',components:[{kind:'fuel-filter',name:'Kraftstofffilter',product:'Kraftstofffilter'}],operations:['Kraftstofffilter erneuern','Kraftstofffilter wechseln']},
  'Starterbatterie ersetzen':{category:'Batterie',components:[{kind:'starter-battery',name:'Starterbatterie',product:'Starterbatterie',brands:['VARTA','EXIDE','BOSCH'],requiredQuantity:1}],operations:['Batterie erneuern']},
  'Zündkerzen wechseln':{category:'Zündkerze',components:[{kind:'spark-plugs',name:'Zündkerzen',product:'Zündkerze',brands:['NGK','DENSO','BOSCH']}],operations:['Zündkerzen erneuern','Alle Zündkerzen erneuern','Zündkerzen erneuern (alle)'],groups:['Zündung','Zündanlage']},
  'Keilrippenriemen-Wechsel':{category:'Keilrippenriemen',components:[{kind:'auxiliary-belt',name:'Keilrippenriemen',product:'\\bKeilrippenriemen\\b(?!-Kit)',brands:['CONTITECH','GATES','DAYCO','INA'],requiredQuantity:1}],operations:['Keilrippenriemen erneuern','Nebenaggregateriemen erneuern','Antriebsriemen erneuern'],groups:['Motor','Riementrieb','Riemenantrieb']},
  'Zahnriemen-Wechsel':{category:'Zahnriemensatz',components:[{kind:'timing-belt-kit',name:'Zahnriemensatz',product:'Zahnriemensatz|Zahnriemen-Kit',brands:['CONTITECH','INA','GATES','DAYCO'],requiredQuantity:1,rejectText:'mit (?:Wasser|Kühlmittel)pumpe'}],operations:['Zahnriemen erneuern','Zahnriemensatz erneuern'],groups:['Motor','Riementrieb','Zahnriemen']},
  'Scheibenwischerblätter vorne wechseln':{category:'Wischerblätter',components:[{kind:'front-wiper-set',name:'Scheibenwischerblätter vorne',product:'Wischblatt|Wischerblatt',axle:'front',brands:['BOSCH','VALEO','SWF','DENSO'],requiredQuantity:1,requireText:'Wischblattsatz|Menge:\\s*2|Länge 1[\\s\\S]{0,100}Länge 2'}],operations:['Wischerblätter erneuern (Windschutzscheibe)','Beide Wischerblätter erneuern (vorne)','Wischerblätter vorne erneuern'],groups:['Scheibenwischer','Karosserie']},
  'Scheibenwischerblatt hinten':{category:'Wischerblätter',components:[{kind:'rear-wiper',name:'Scheibenwischerblatt hinten',product:'Wischblatt|Wischerblatt',axle:'rear',brands:['BOSCH','VALEO','SWF','DENSO'],requiredQuantity:1}],operations:['Wischerblatt erneuern (Heckscheibe)','Wischerblatt hinten erneuern'],groups:['Scheibenwischer','Karosserie']}
});
export const serviceComponents=names=>names.flatMap(name=>vehicleServices[name]?.components||[]);
export const brakeBrands=['ATE','BREMBO','TRW','TEXTAR','BOSCH','ZIMMERMANN','JURID','FERODO','PAGID','DELPHI','BENDIX','HELLA PAGID','HELLA','METELLI','MEYLE','REMSA','ROADHOUSE','A.B.S.','LPR','CIFAM','ICER','FEBI BILSTEIN'];
export function catalogBrand(text,names){
  const markers=[...text.matchAll(/^Katalog-Marke:\s*([^\n]+)$/gm)].map(x=>x[1].trim());
  if(markers.length===1)return names.includes(markers[0])?markers[0]:null;
  const lines=text.split('\n').map(x=>x.trim());
  const matches=names.filter(name=>lines.includes(name));
  return matches.length===1?matches[0]:null;
}
export function componentCandidate(text,component,readPrice,scope={}){
  if(!/\bVIN\b/.test(text)||/Auf Anfrage|ABVERKAUFSARTIKEL/i.test(text)||!new RegExp(component.product,'i').test(text))return null;
  if(component.axle){
    const side=component.axle==='front'?'Vorderachse|vorne':'Hinterachse|hinten';
    const other=component.axle==='front'?'Hinterachse|hinten':'Vorderachse|vorne';
    const declared=new RegExp('(?:Einbau(?:seite|ort)|Standort)\\s*:\\s*(?:'+side+')','i').test(text);
    if(!declared&&new RegExp('(?:Einbau(?:seite|ort)|Standort)\\s*:\\s*(?:'+other+')','i').test(text))return null;
    if(!declared&&!(scope.confirmed===true&&scope.axle===component.axle))return null;
  }
  const quantity=Number(text.match(/benötigte Stückzahl:\s*(\d+)\b/)?.[1]);
  if(!Number.isInteger(quantity)||quantity<1||quantity>20)return null;
  if(component.requiredQuantity&&quantity!==component.requiredQuantity)return null;
  if(component.requireText&&!new RegExp(component.requireText,'i').test(text))return null;
  if(component.rejectText&&new RegExp(component.rejectText,'i').test(text))return null;
  const completeKit=quantity===1&&((component.kind.endsWith('-pads')&&/Bremsbelagsatz/i.test(text))
    ||(component.kind==='timing-belt-kit'&&/Zahnriemensatz|Zahnriemen-Kit/i.test(text))
    ||(component.kind==='front-wiper-set'&&new RegExp(component.requireText,'i').test(text)));
  if(/\d+ Stück = 1 Pack/i.test(text)&&!completeKit)return null;
  if(component.kind.endsWith('-discs')&&quantity!==2)return null;
  if(component.kind.endsWith('-pads')&&quantity!==1)return null;
  const number=text.match(/Artikel Nr\.:\s*([^\n]+?)(?:\n|$)/)?.[1]?.trim();
  if(!number||number.length>60)return null;
  const brands=component.brands||(component.axle?brakeBrands:['MANN-FILTER','MAHLE','BOSCH']);
  const brand=catalogBrand(text,brands);if(!brand)return null;
  let price;try{price=readPrice(text)}catch{return null}
  return {kind:component.kind,partNumber:number,description:brand+' '+component.name,quantity,unitNetCents:price,priceBasis:'retail-ex-vat',brand};
}
export function operationEvidence(text,names){
  const matches=[];
  for(const name of names){
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(escaped+'\\s*OE\\s*:\\s*([\\w-]+)\\s*\\+?\\s*(\\d+[.,]\\d{2})(?!\\d)','gi');
    for(const match of text.matchAll(re))matches.push({operation:match[1],hours:Number(match[2].replace(',','.'))});
  }
  const unique=[...new Map(matches.map(x=>[x.operation+':'+x.hours,x])).values()];
  return unique.length===1&&unique[0].hours>0&&unique[0].hours<=12?unique[0]:null;
}
