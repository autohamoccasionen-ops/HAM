export const oilBrands=['CASTROL','MOBIL','LIQUI MOLY','FUCHS','MOTUL','RAVENOL','SHELL','TOTALENERGIES','VALVOLINE'];
export function engineOilSpecification(text){
  // The verified engine-lubricant table presents grade and approval across
  // cells/lines without repeating "Motoröl" on that row. Keep that confirmed
  // mapping valid; never infer this approval from viscosity alone.
  if(/SAE 0W-20\s+MB 229\.71/.test(String(text)))return {viscosity:'0W20',approval:'MB 229.71',query:'229.71'};
  // A preferred specification can occupy separate cells/lines in HaynesPro.
  // Join only an explicitly labelled engine-oil block, never other fluids.
  const rows=String(text).replace(/Motor(?:en)?öl\s*\((?:Bevorzugte|Alternative) Schmiermittelspezifikation\)\s*\n\s*SAE\s+([^\n]+)\n\s*([^\n]+)/gi, 'Motoröl SAE $1 $2');
  for(const line of rows.split('\n')){
    const match=line.trim().match(/^Motor(?:en)?öl\s+SAE\s+(\d{1,2}W[ -]?\d{2})\s+(.+?)(?:\s+(?:Alle Temperaturen|Über\s|Unter\s|Von\s|Bis\s)|$)/i);
    if(!match)continue;
    const approval=match[2].trim();
    // Industry classifications alone do not establish a manufacturer approval.
    if(/^(?:ACEA|API|ILSAC|JASO|SAE)\b/i.test(approval)||!/\d/.test(approval)
      ||! /^[\p{L}\p{N} ._()/+-]{3,100}$/u.test(approval))continue;
    const viscosity=match[1].toUpperCase().replace(/[ -]/g,'');
    const number=approval.match(/^(?:MB|VW)\s+(\d[\d .]+)$/i)?.[1];
    return {viscosity,approval,query:number?number.replace(/\s/g,''):approval};
  }
  return null;
}
export function approvedOilProduct(text,spec){
  const litres=Number(String(text).match(/Inhalt \[Liter\]:\s*(\d+(?:[.,]\d+)?)/i)?.[1]?.replace(',','.'));
  if(litres!==1||!/Motor(?:en)?öl/i.test(text)||/Getriebeöl|ABVERKAUFSARTIKEL|Auf Anfrage/i.test(text))return false;
  const grades=[...String(text).matchAll(/\b(\d{1,2}W)[ -]?(\d{2})\b/gi)].map(x=>(x[1]+x[2]).toUpperCase());
  if(!grades.includes(spec.viscosity))return false;
  const tokens=spec.approval.split(/[\s._/+-]+/).filter(Boolean).map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const pattern=new RegExp('\\b'+tokens.join('[\\s._/,+-]*')+'\\b','i');
  const declarations=[...String(text).matchAll(/(?:^|\n)\s*Herstellerfreigabe(?:n)?\s*:\s*([^\n]+)/gi)];
  return declarations.some(x=>pattern.test(x[1]));
}

