// Category and operation names are supplied by D-Store and HaynesPro.
// A definition is a lookup rule, never a cached part, price or labour time.
const brake = (axle, discs) => ({
  category:'Scheibenbremse', categoryAxle:axle,
  components:[...(discs?[{kind:axle+'-discs',name:'Bremsscheiben '+(axle==='front'?'Vorderachse':'Hinterachse'),product:'Bremsscheibe',axle}]:[]),
    {kind:axle+'-pads',name:'Bremsbeläge '+(axle==='front'?'Vorderachse':'Hinterachse'),product:'Bremsbelag(?:satz)?',axle}],
  operations:[discs?`Beide Bremsscheiben erneuern (${axle==='front'?'Vorderachse':'Hinterachse'})`:`Bremsbeläge erneuern (${axle==='front'?'Vorderachse':'Hinterachse'})`]
});
export const vehicleServices=Object.freeze({
  'Bremsscheiben inkl. Bremsbeläge Vorderachse erneuern':brake('front',true),
  'Bremsbeläge Vorderachse erneuern':brake('front',false),
  'Bremsscheiben inkl. Bremsbeläge Hinterachse erneuern':brake('rear',true),
  'Bremsbeläge Hinterachse erneuern':brake('rear',false),
  'Luftfilter-Wechsel':{category:'Luftfilter',components:[{kind:'air-filter',name:'Luftfilter',product:'\\bLuftfilter\\b'}],operations:['Luftfilter erneuern','Luftfilter wechseln']},
  'Pollenfilter-Wechsel':{category:'Innenraumfilter',components:[{kind:'cabin-filter',name:'Pollenfilter',product:'Innenraumluft|Innenraumfilter|Pollenfilter'}],operations:['Innenraumfilter erneuern','Innenraumluftfilter erneuern','Pollenfilter erneuern','Filter für Innenraumluft erneuern']},
  'Kraftstofffilter wechseln':{category:'Kraftstofffilter',components:[{kind:'fuel-filter',name:'Kraftstofffilter',product:'Kraftstofffilter'}],operations:['Kraftstofffilter erneuern','Kraftstofffilter wechseln']}
});
export const serviceComponents=names=>names.flatMap(name=>vehicleServices[name]?.components||[]);
export function componentCandidate(text,component,readPrice){
  if(!/\bVIN\b/.test(text)||/Auf Anfrage|ABVERKAUFSARTIKEL|\d+ Stück = 1 Pack/i.test(text)||!new RegExp(component.product,'i').test(text))return null;
  if(component.axle){
    const side=component.axle==='front'?'Vorderachse|vorne':'Hinterachse|hinten';
    if(!new RegExp('Einbau(?:seite|ort)\\s*:\\s*(?:'+side+')','i').test(text))return null;
  }
  const quantity=Number(text.match(/benötigte Stückzahl:\s*(\d+)\b/)?.[1]);
  if(!Number.isInteger(quantity)||quantity<1||quantity>8)return null;
  if(component.kind.endsWith('-discs')&&quantity!==2)return null;
  if(component.kind.endsWith('-pads')&&quantity!==1)return null;
  const number=text.match(/Artikel Nr\.:\s*([^\n]+?)(?:\n|$)/)?.[1]?.trim();
  if(!number||number.length>60)return null;
  const brands=component.axle?['ATE','BREMBO','TRW','TEXTAR','BOSCH','ZIMMERMANN']:['MANN-FILTER','MAHLE','BOSCH'];
  const brand=brands.find(x=>text.includes(x));if(!brand)return null;
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
