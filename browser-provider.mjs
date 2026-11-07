import { QuoteError, parseOilCapacity, parseOilHours, retailPriceCents } from './quote.mjs';
import { vehicleServices,serviceComponents,componentCandidate,operationEvidence,catalogBrand,brakeBrands } from './vehicle-services.mjs';
import {engineOilSpecification,approvedOilProduct,oilBrands} from './oil-specs.mjs';

// Read-only browser integration. No account changes, cart additions, orders,
// offer submission, CAPTCHA solving, trace capture or cookie export.
const DSTORE = 'https://d-store.ch';
const clean = text => String(text).replace(/\u00a0/g, ' ').trim();
const manual = message => new QuoteError('MANUAL_REVIEW_REQUIRED', message);
const invalidLogin = /Falsches Passwort|incorrect username or password|Benutzername.*ungültig|Sitzung ist abgelaufen|(?:Benutzername|Passwort|Zugangsdaten|Anmeldedaten)[^\n]{0,100}(?:falsch|ungültig|nicht korrekt)|(?:falsch|ungültig)[^\n]{0,60}(?:Benutzername|Passwort|Zugangsdaten|Anmeldedaten)/i;

// Runs in the supplier page. Only the CMP's documented public API is used:
// https://usercentrics.com/docs/web/features/api/control-functionality/
// No storage edits, overlay removal, request blocking or security bypasses.
export async function saveEssentialConsentInPage(timeoutMs = 10000) {
  let timer;
  let phase = 'initialize';
  const operation = (async () => {
  const cmp = window.__ucCmp;
  if (!cmp || typeof cmp.isInitialized !== 'function' || !await cmp.isInitialized()) return 'not-ready';
  if (typeof cmp.isAgeVerificationRequired === 'function' && await cmp.isAgeVerificationRequired()) return 'manual-required';
  if (typeof cmp.isConsentRequired === 'function' && !await cmp.isConsentRequired()) return 'not-required';
  if (typeof cmp.denyAllConsents !== 'function' || typeof cmp.saveConsents !== 'function'
    || typeof cmp.closeCmp !== 'function') return 'unsupported';
  phase = 'deny';
  await cmp.denyAllConsents();
  phase = 'save';
  await cmp.saveConsents('IMPLICIT');
  phase = 'close';
  await cmp.closeCmp();
  return 'essential-only-saved';
  })();
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CMP_TIMEOUT_${phase}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function consentWithFallback(ui, api) {
  if (await ui()) return true;
  let result;
  try { result = await api(); }
  catch (error) {
    // Initialization failure has not changed any consent. A normal visible UI
    // action is still safe. Never retry a partial save or an age-verification wall.
    if (/CMP_TIMEOUT_initialize/.test(String(error?.message || '')) && await ui()) return true;
    throw error;
  }
  if (result === 'manual-required') throw new QuoteError('SOURCE_UNAVAILABLE', 'Der Datenanbieter erfordert eine manuelle Prüfung.', 503);
  return result === 'essential-only-saved' || await ui();
}

async function rejectVisibleCookieConsent(page, waitForUI = false) {
  if (waitForUI) {
    await page.locator('[id*="usercentrics"]').getByRole('button').first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  }
  try {
    return await consentWithFallback(() => clickVisibleCookieConsent(page), async () => {
      const result = await page.evaluate(saveEssentialConsentInPage);
      if (result === 'essential-only-saved') console.info(JSON.stringify({ component: 'supplier-consent', outcome: 'essential-only-api-saved' }));
      return result;
    });
  } catch (error) {
    const phase = String(error?.message || '').match(/CMP_TIMEOUT_(initialize|deny|save|close)/)?.[1];
    if (!phase) throw error;
    console.warn(JSON.stringify({ component: 'supplier-consent', outcome: 'timeout', phase }));
    throw new QuoteError('CONSENT_UNAVAILABLE', 'Das Cookie-Fenster des Datenanbieters konnte nicht abgeschlossen werden.', 503);
  }
}

async function clickVisibleCookieConsent(page) {
  const rejectName = /^(?:(?:alle|alles|cookies)\s+)?ablehnen$|^nur (?:notwendige|erforderliche|essenzielle|essentielle)(?: cookies)?(?: (?:akzeptieren|zulassen|verwenden))?$|^reject(?: all)?$/i;
  for (const frame of page.frames()) {
    const privacy = frame.locator('#uc-main-dialog');
    const save = privacy.getByRole('button', { name: /^(Einstellungen speichern|Auswahl speichern|Save settings|Save preferences)$/i });
    if (await save.count() === 1 && await save.isVisible()) {
      // Usercentrics exposes optional categories as named switches. The
      // essential, disabled category is deliberately never changed.
      for (const name of ['Funktionell', 'Marketing', 'Analyse']) {
        const toggle = privacy.getByRole('switch', { name, exact: true });
        if (await toggle.count() === 1 && await toggle.isVisible() && await toggle.isEnabled()
          && await toggle.getAttribute('aria-checked') === 'true') await toggle.click();
      }
      await save.click();
      console.info(JSON.stringify({ component: 'supplier-consent', outcome: 'essential-only-saved' }));
      return true;
    }
    const buttons = frame.getByRole('button', { name: rejectName });
    for (const button of await buttons.all()) {
      if (!await button.isVisible()) continue;
      const text = await frame.locator('body').innerText();
      if (!/cookie|datenschutz|privacy|consent/i.test(text)) continue;
      if (/verify you are human|checking your browser|automated traffic|captcha/i.test(text)) {
        throw new QuoteError('SOURCE_UNAVAILABLE', 'Der Datenanbieter erfordert eine manuelle Prüfung.', 503);
      }
      await button.click();
      return true;
    }
  }
  return false;
}

function interceptedElementCategory(error) {
  const entries = String(error?.message || '').split('\n').filter(line => /intercepts pointer events/.test(line));
  const categories = ['cookie', 'consent', 'usercentrics', 'onetrust', 'dialog', 'modal', 'loading', 'spinner', 'blockui', 'captcha', 'challenge'];
  return categories.filter(category => entries.some(line => line.toLowerCase().includes(category)));
}

async function clickWithCookieConsent(page,target,options){
  try{return await target.click(options)}
  catch(error){
    const categories=interceptedElementCategory(error);
    if(!categories.includes('usercentrics')||categories.includes('captcha')||categories.includes('challenge')
      ||!await rejectVisibleCookieConsent(page,true))throw error;
    return target.click(options);
  }
}

async function publicConsentControls(page, credentials) {
  const results = [];
  for (const frame of page.frames()) {
    // Only public CMP control labels, never auth fields or whole-page text.
    const hosts = frame.locator('[id*="usercentrics"]');
    for (const host of await hosts.all()) {
      const labels = await host.getByRole('button').allTextContents();
      results.push(...labels.map(clean).filter(label => label && label.length <= 80
        && !label.includes(credentials.username) && !label.includes(credentials.password)
        && !/@|https?:/i.test(label)));
    }
  }
  return [...new Set(results)].slice(0, 15);
}

async function checkLogin(page) {
  const text = await page.locator('body').innerText();
  if (invalidLogin.test(text)) {
    throw new QuoteError('AUTHENTICATION_REQUIRED', 'Der Datenzugang muss erneuert werden.', 503);
  }
  if (/verify you are human|checking your browser|automated traffic|access denied|captcha/i.test(text)) {
    throw new QuoteError('SOURCE_UNAVAILABLE', 'Der Datenanbieter erfordert eine manuelle Prüfung.', 503);
  }
}

async function visibleText(page) {
  await checkLogin(page);
  return clean(await page.locator('body').innerText());
}

async function search(page, term) {
  const box = page.getByRole('textbox', { name: 'Volltextsuche: Artikel, Fahrzeuge, VIN, etc', exact: true });
  await box.fill(term);
  await box.press('Enter');
  await page.getByText(`Suchergebnisse "${term}"`, { exact: true }).waitFor();
  await page.locator('[id^="part-detail-"]').first().waitFor();
}

function articleNumber(text) {
  const match = text.match(/Artikel Nr\.:\s*([^\n]+)/);
  if (!match) throw manual('Artikelnummer nicht eindeutig gelesen.');
  return match[1].trim();
}

export function normalizeCatalogText(text, labels = []) {
  let result = String(text).replace(/\bOelfilter\b/gi, 'Ölfilter');
  const names = [...new Set(['MAHLE', 'MANN-FILTER', 'BOSCH', 'ELRING', 'FEBI BILSTEIN', 'HERTH+BUSS ELPARTS',...brakeBrands,...oilBrands,'VARTA','EXIDE','NGK','DENSO','CONTITECH','GATES','DAYCO','INA','VALEO','SWF'])];
  const normalized = labels.map(label => String(label || '').trim().toUpperCase());
  const brands = names.filter(name => normalized.some(label => [name, `${name} LOGO`, `LOGO ${name}`].includes(label)));
  if (brands.length === 1 && !result.includes(brands[0])) result += '\n' + brands[0];
  if (brands.length === 1) result += '\nKatalog-Marke: ' + brands[0];
  if (normalized.includes('VIN') && !/\bVIN\b/.test(result)) result += '\nVIN';
  return result;
}

export function oilPackageConfirmed(text) {
  const litres = Number(String(text).match(/Inhalt \[Liter\]:\s*(\d+(?:[.,]\d+)?)/)?.[1]?.replace(',', '.'));
  return litres === 1 && /\b0W\s*-?\s*20\b/.test(text);
}

async function completeArticleContainer(card) {
  let article = card;
  for (let depth = 0; depth < 5; depth++) {
    const parent = article.locator('..');
    if (await parent.locator('[id^="part-detail-"]').count() !== 1) break;
    article = parent;
  }
  return article;
}

async function readCatalogCard(card) {
  const text = await card.innerText();
  const labels = await card.locator('img[alt], [aria-label], [title]').evaluateAll(nodes => nodes.flatMap(node =>
    ['alt', 'aria-label', 'title'].map(attribute => node.getAttribute(attribute)).filter(Boolean)));
  return normalizeCatalogText(text, labels);
}

async function catalogueCards(page){
  const ids=await page.locator('[id^="part-detail-"]').evaluateAll(nodes=>nodes.map(n=>n.id));
  if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw manual('Artikelzuordnung muss geprüft werden.');
  return ids.map(id=>page.locator('[id="'+id.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"]').filter({visible:true}));
}

async function waitForRetailPrice(article){
  await article.filter({hasText:/UVPE\s*:\s*[\d’'.,]+\s*CHF[\s\S]*exkl\.\s*MwSt\./}).waitFor();
}

async function closeHaynesLaunchDialog(page) {
  const dialogs = page.getByRole('dialog').filter({ visible: true });
  for (const dialog of await dialogs.all()) {
    if (await dialog.getByRole('button', { name: 'Hier geht es zu HaynesPro', exact: true }).count() !== 1) continue;
    const close = dialog.getByRole('button', { name: /^(Close|Schliessen|Schließen|Fenster schliessen|Fenster schließen)$/i });
    if (await close.count() === 1 && await close.isVisible()) await close.click();
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'haynes-launch-dialog-closed' }));
    return true;
  }
  return false;
}

export function materialCandidate(text, kind) {
  text = clean(text);
  if (!/\bVIN\b/.test(text) || /Auf Anfrage|ABVERKAUFSARTIKEL|\d+ Stück = 1 Pack/.test(text)) return null;
  if (kind === 'filter' && (!/Ölfilter/.test(text) || !/mit Dichtung/.test(text))) return null;
  if (kind === 'drain-plug' && (!/Verschlussschraube, Ölwanne/.test(text) || !/mit Dichtring|mit Dichtung/.test(text))) return null;
  const quantity = text.match(/benötigte Stückzahl:\s*(\d+)/);
  if (quantity && Number(quantity[1]) !== 1) return null;
  const brand = catalogBrand(text,kind === 'filter' ? ['MAHLE', 'MANN-FILTER', 'BOSCH']
    : ['ELRING', 'FEBI BILSTEIN', 'HERTH+BUSS ELPARTS']);
  if (!brand) return null;
  return { kind, partNumber: articleNumber(text), description: `${brand} ${kind === 'filter' ? 'Ölfilter mit Dichtung' : 'Ölablassschraube mit Dichtring'}`,
    quantity: 1, unitNetCents: retailPriceCents(text), priceBasis: 'retail-ex-vat', brand };
}

async function chooseMaterials(page) {
  const cards = await catalogueCards(page);
  const entries = [];
  for (const card of cards) {
    if (await card.isVisible()) {
      const article = await completeArticleContainer(card);
      entries.push({ card: article, text: await readCatalogCard(article) });
    }
  }
  const selectedParts = [];
  for (const kind of ['filter', 'drain-plug']) {
    const priorities = kind === 'filter' ? ['MAHLE', 'MANN-FILTER', 'BOSCH'] : ['ELRING', 'FEBI BILSTEIN', 'HERTH+BUSS ELPARTS'];
    let selected;
    brandSearch: for (const brand of priorities) {
      for (const entry of entries) {
        if (catalogBrand(entry.text,priorities)!==brand || !(kind === 'filter' ? /Ölfilter/.test(entry.text) : /Verschlussschraube, Ölwanne/.test(entry.text))) continue;
        await waitForRetailPrice(entry.card);
        entry.text=await readCatalogCard(entry.card);
        let candidate = materialCandidate(entry.text, kind);
        if (!candidate) {
          const details = entry.card.getByRole('button', { name: 'Mehr Details', exact: true }).filter({ visible: true });
          if (await details.count() === 1) {
            await clickWithCookieConsent(page,details);
            await entry.card.getByText(/mit Dichtung|mit Dichtring/).first()
              .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
            entry.text = await readCatalogCard(entry.card);
            candidate = materialCandidate(entry.text, kind);
          }
        }
        if (candidate) { selected = candidate; break brandSearch; }
      }
    }
    if (!selected) {
      console.warn(JSON.stringify({ component: 'supplier-material-criteria', kind, cards: entries.slice(0, 16).map(({ text }) => ({
        vinBadge: /\bVIN\b/.test(text), filterName: /Ölfilter/.test(text), plugName: /Verschlussschraube, Ölwanne/.test(text),
        seal: /mit Dichtring|mit Dichtung/.test(text), preferredBrand: priorities.find(brand => text.includes(brand)) || null,
        retailLabel: /UVPE:\s*\d/.test(text), unpriced: /Auf Anfrage/.test(text),
        quantity: Number(text.match(/benötigte Stückzahl:\s*(\d+)/)?.[1]) || null
      })) }));
      throw manual('Passender Ölfilter oder Ablassstopfen mit Dichtung nicht eindeutig gefunden.');
    }
    const { brand, ...part } = selected;
    selectedParts.push(part);
  }
  return selectedParts;
}

export function categoryCheckboxState(element) {
  const input = element.type === 'checkbox' ? element : element.querySelector?.('input[type="checkbox"]');
  if (input && typeof input.checked === 'boolean') return input.checked;
  const aria = element.getAttribute?.('aria-checked');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  return null;
}

export function uniqueCheckboxChange(before, after) {
  if (!before.length || before.length !== after.length || new Set(before.map(row => row.id)).size !== before.length) return null;
  const changed = [];
  for (let i = 0; i < before.length; i++) {
    if (!before[i].id || before[i].id !== after[i].id || typeof before[i].checked !== 'boolean'
      || typeof after[i].checked !== 'boolean') return null;
    if (before[i].checked !== after[i].checked) changed.push(i);
  }
  return changed.length === 1 ? changed[0] : null;
}

async function selectCategoryByObservedChange(page, row, label, desired = true) {
  const snapshot = () => row.getByRole('checkbox').evaluateAll(nodes => nodes.map(node => ({
    id: node.id || null, checked: node.type === 'checkbox' ? node.checked
      : node.getAttribute('aria-checked') === 'true' ? true : node.getAttribute('aria-checked') === 'false' ? false : null
  })));
  const before = await snapshot();
  if (before.some(item => !item.id || typeof item.checked !== 'boolean')) return false;
  await clickWithCookieConsent(page,label);
  for (let attempt = 0; attempt < 5; attempt++) {
    const after = await snapshot();
    const index = uniqueCheckboxChange(before, after);
    if (index !== null) {
      if (after[index].checked === desired) return true;
      // The category was already selected. Restore it through the same label.
      await clickWithCookieConsent(page,label);
      const restored = await snapshot();
      return restored.length === before.length && restored.every((item, i) => item.id === before[i].id
        && item.checked === (i === index ? desired : before[i].checked));
    }
    await page.waitForTimeout(100);
  }
  return false;
}

async function clickCategory(page, name, explicitLabel, desired = true) {
  const panel = page.getByRole('tabpanel', { name: 'Quick Click', exact: true });
  const scope = await panel.count() === 1 ? panel : page;
  // The same name also appears in the navigation tree. Its DIV is not the
  // Quick Click checkbox label, which is rendered inside p-checkbox.
  let label = explicitLabel || scope.locator('p-checkbox').getByText(name, { exact: true }).filter({ visible: true });
  if (await label.count() !== 1) label = scope.getByText(name, { exact: true }).filter({ visible: true });
  if (await label.count() !== 1) throw manual('Teilekategorie nicht eindeutig.');
  const row = label.locator('..');
  let matches = scope.getByRole('checkbox', { name, exact: true });
  if (await matches.count() !== 1) matches = scope.getByLabel(name, { exact: true });
  if (await matches.count() !== 1) {
    // Some category layouts put two controls in the same row. Resolve the
    // native label association instead of choosing the first checkbox.
    const candidates = await row.getByRole('checkbox').all();
    const associated = [];
    for (const candidate of candidates) {
      if (await candidate.evaluate((node, text) => Array.from(node.labels || [])
        .some(label => label.innerText.trim() === text), name)) associated.push(candidate);
    }
    if (associated.length === 1) matches = associated[0];
    else matches = row.getByRole('checkbox');
  }
  if (await matches.count() !== 1) {
    if (await selectCategoryByObservedChange(page, row, label, desired)) return;
    throw manual('Teileauswahl muss geprüft werden.');
  }
  const checkbox = matches.first();
  const checked = () => checkbox.evaluate(categoryCheckboxState);
  const initial = await checked();
  if (initial === null) throw manual('Teileauswahl muss geprüft werden.');
  if (initial === desired) return;
  // Styled tree checkboxes cover the native input with their visible label.
  // Use that normal user-facing target, then verify actual checked state.
  await clickWithCookieConsent(page,label);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await checked() === desired) return;
    await page.waitForTimeout(100);
  }
  const wrapper = checkbox.locator('..');
  if (await wrapper.isVisible() && await wrapper.getByRole('checkbox').count() === 1) {
    await clickWithCookieConsent(page,wrapper);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await checked() === desired) return;
      await page.waitForTimeout(100);
    }
  }
  throw manual('Teileauswahl muss geprüft werden.');
}

async function chooseRequestedMaterials(page,vehicleUrl,names){
  const selected=[];
  let previousCategories=['Oelfilter','Ablassschraube Ölwanne'];
  const groups=[...new Map(names.map(name=>{const d=vehicleServices[name];return [d.category+':'+(d.categoryAxle||''),{category:d.category,axle:d.categoryAxle}]})).values()];
  for(const group of groups){
    const {category,axle}=group;
    const groupNames=names.filter(name=>vehicleServices[name].category===category&&vehicleServices[name].categoryAxle===axle);
    console.info(JSON.stringify({component:'supplier-extra-progress',step:'category',category}));
    // Preserve the supplier's verified per-tab VIN context through its normal
    // history navigation; a fresh generic vehicle page does not retain it.
    await page.goBack({waitUntil:'domcontentloaded'});
    if(page.url()!==vehicleUrl)await page.goto(vehicleUrl,{waitUntil:'domcontentloaded'});
    try{await page.getByRole('button',{name:'Fahrzeug ändern',exact:true}).waitFor()}
    catch(error){console.warn(JSON.stringify({component:'supplier-extra-navigation',loginForm:await page.locator('input[type="password"]').isVisible().catch(()=>false),expiredSession:await page.getByText('Die aktuelle Sitzung ist abgelaufen!',{exact:true}).isVisible().catch(()=>false)}));throw error}
    await rejectVisibleCookieConsent(page);
    await clickWithCookieConsent(page,page.getByText('Quick Click',{exact:true}));
    await page.locator('p-checkbox').getByText(category,{exact:true}).filter({visible:true}).first().waitFor();
    // Do not accumulate products from earlier categories in the same portal
    // session. Change normal checkbox controls and verify their actual state.
    for(const name of previousCategories){
      const labels=page.locator('p-checkbox').getByText(name,{exact:true}).filter({visible:true});
      console.info(JSON.stringify({component:'supplier-extra-reset',category:name,labelCount:await labels.count()}));
      for(const label of await labels.all())await clickCategory(page,name,label,false);
    }
    const definition=vehicleServices[groupNames[0]];
    if(definition.categoryAxle){
      const labels=page.locator('p-checkbox').getByText(category,{exact:true}).filter({visible:true});
      console.info(JSON.stringify({component:'supplier-extra-category-count',category,count:await labels.count()}));
      if(await labels.count()!==2)throw manual('Bremsen-Kategorien müssen eindeutig zugeordnet werden.');
      const requestedAxles=[axle];
      const shapes=await labels.evaluateAll(nodes=>nodes.map(n=>{
        const result=[];let parent=n;
        for(let i=0;i<7&&parent;i++,parent=parent.parentElement){const t=parent.innerText||'';result.push({tag:parent.tagName,front:/Vorderachse|vorne/i.test(t),rear:/Hinterachse|hinten/i.test(t),length:t.length})}
        return result;
      }));
      console.info(JSON.stringify({component:'supplier-brake-category-shape',shapes}));
      for(const label of await labels.all())await clickCategory(page,category,label,false);
      for(const axle of requestedAxles){
        const indices=shapes.map((levels,index)=>({index,match:levels.some(x=>axle==='front'?x.front&&!x.rear:x.rear&&!x.front)})).filter(x=>x.match);
        if(indices.length!==1)throw manual('Bremsen-Kategorien müssen eindeutig zugeordnet werden.');
        await clickCategory(page,category,(await labels.all())[indices[0].index]);
      }
    }else await clickCategory(page,category);
    await clickWithCookieConsent(page,page.getByRole('button',{name:'Artikel anzeigen',exact:true}));
    console.info(JSON.stringify({component:'supplier-extra-progress',step:'articles-opened',category}));
    await page.locator('[id^="part-detail-"]').filter({hasText:/UVPE:\s*[\d’'.,]+\s*CHF/}).first().waitFor();
    const scope=definition.categoryAxle?{confirmed:true,axle}:{};
    const components=serviceComponents(groupNames);
    const entries=[];
    const cards=await catalogueCards(page);
    console.info(JSON.stringify({component:'supplier-extra-progress',step:'article-count',category,count:cards.length}));
    for(const card of cards){
      if(!await card.isVisible())continue;
      const article=await completeArticleContainer(card);
      await waitForRetailPrice(article);
      let text=await readCatalogCard(article);
      if(!components.some(c=>new RegExp(c.product,'i').test(text)))continue;
      // The initial result card carries the supplier's VIN fitment badge.
      // Unconfirmed universal alternatives must not become vehicle quotations.
      if(!/\bVIN\b/.test(text))continue;
      if(definition.categoryAxle&&!catalogBrand(text,brakeBrands)){
        const labels=await article.locator('img[alt]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('alt')||'')
          .map(x=>x.trim()).filter(x=>x&&x.length<=80&&!/[A-HJ-NPR-Z0-9]{17}/.test(x)).slice(0,12));
        const names=text.split('\n').map(x=>x.trim()).filter(x=>x.length<=100&&/Bremsbel|Bremskl|Belagsatz/i.test(x)).slice(0,3);
        console.info(JSON.stringify({component:'supplier-extra-brand-evidence',category,labels,names}));
      }
      if(!components.some(c=>componentCandidate(text,c,retailPriceCents,scope))){
        const details=article.getByRole('button',{name:'Mehr Details',exact:true}).filter({visible:true});
        console.info(JSON.stringify({component:'supplier-extra-progress',step:'product-details',category,detailsCount:await details.count(),quantity:Number(text.match(/benötigte Stückzahl:\s*(\d+)/)?.[1])||null,brand:catalogBrand(text,brakeBrands),packaged:/\d+ Stück = 1 Pack/i.test(text),unpriced:/Auf Anfrage|ABVERKAUFSARTIKEL/i.test(text)}));
        if(await details.count()===1){
          try{await clickWithCookieConsent(page,details,{timeout:10000})}
          catch(error){text=await readCatalogCard(article);if(!components.some(c=>componentCandidate(text,c,retailPriceCents,scope)))throw error}
          for(let attempt=0;attempt<10;attempt++){text=await readCatalogCard(article);if(components.some(c=>componentCandidate(text,c,retailPriceCents,scope)))break;await page.waitForTimeout(200)}
        }
      }
      entries.push(text);
    }
    for(const component of components){
      const candidates=entries.map(text=>componentCandidate(text,component,retailPriceCents,scope)).filter(Boolean);
      console.info(JSON.stringify({component:'supplier-extra-material-criteria',kind:component.kind,candidateCount:candidates.length,
        cards:entries.slice(0,30).map(text=>({vin:/\bVIN\b/.test(text),product:new RegExp(component.product,'i').test(text),
          front:/Einbau(?:seite|ort)\s*:\s*(?:Vorderachse|vorne)/i.test(text),rear:/Einbau(?:seite|ort)\s*:\s*(?:Hinterachse|hinten)/i.test(text),
          quantity:Number(text.match(/benötigte Stückzahl:\s*(\d+)/)?.[1])||null,price:/UVPE:/.test(text),
          brand:catalogBrand(text,brakeBrands),kit:/Bremsbelagsatz/i.test(text),packaged:/\d+ Stück = 1 Pack/i.test(text),unpriced:/Auf Anfrage|ABVERKAUFSARTIKEL/i.test(text)}))}));
      const brands=component.brands||(component.axle?brakeBrands:['MANN-FILTER','MAHLE','BOSCH']);
      let found;
      for(const brand of brands){
        const matches=[...new Map(candidates.filter(x=>x.brand===brand).map(x=>[x.partNumber,x])).values()];
        if(matches.length===1){found=matches[0];break}
        if(matches.length>1)throw manual('Mehrere passende Teilevarianten erfordern eine fahrzeugspezifische Prüfung.');
      }
      if(!found)throw manual('Teilezuordnung, Einbauseite oder benötigte Stückzahl konnte nicht bestätigt werden.');
      const {brand,...part}=found;selected.push(part);
    }
    previousCategories=[category];
  }
  // Leave the completed product list before opening the labour-data tab.
  await page.goBack({waitUntil:'domcontentloaded'});
  if(page.url()!==vehicleUrl)await page.goto(vehicleUrl,{waitUntil:'domcontentloaded'});
  return {selected,page};
}

async function chooseApprovedEngineOil(page,spec){
  await search(page,spec.query);
  const candidates=[];
  for(const card of await catalogueCards(page)){
    if(!await card.isVisible())continue;
    const article=await completeArticleContainer(card);
    let text=await readCatalogCard(article);
    if(!/Motor(?:en)?öl/i.test(text))continue;
    if(!approvedOilProduct(text,spec)){
      const details=article.getByRole('button',{name:'Mehr Details',exact:true}).filter({visible:true});
      if(await details.count()===1){await clickWithCookieConsent(page,details);await article.getByText(/Herstellerfreigabe/).first().waitFor({timeout:5000}).catch(()=>{});text=await readCatalogCard(article);}
    }
    if(!approvedOilProduct(text,spec))continue;
    await waitForRetailPrice(article);text=await readCatalogCard(article);
    let price;try{price=retailPriceCents(text)}catch{continue}
    const brand=catalogBrand(text,oilBrands);
    candidates.push({kind:'oil',partNumber:articleNumber(text),description:(brand?brand+' ':'')+'Motoröl SAE '+spec.viscosity+', '+spec.approval,
      unitNetCents:price,priceBasis:'retail-ex-vat',rank:brand?oilBrands.indexOf(brand):oilBrands.length});
  }
  candidates.sort((a,b)=>a.rank-b.rank||a.unitNetCents-b.unitNetCents||a.partNumber.localeCompare(b.partNumber));
  if(!candidates.length)throw manual('Kein Motoröl mit bestätigter Herstellerfreigabe, Viskosität und Gebindegrösse gefunden.');
  const {rank,...oil}=candidates[0];return oil;
}

export async function readQuote(input, credentials) {
  const { chromium } = await import('playwright');
  let stage = 'browser-launch';
  const consentNetworkFailures = [];
  const reportFailure = error => console.warn(JSON.stringify({ component: 'supplier-lookup', stage,
    failure: error instanceof QuoteError ? error.code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'BROWSER_ERROR',
    reviewReason: { 'Teilekategorie nicht eindeutig.': 'CATEGORY_LABEL_AMBIGUOUS',
      'Teileauswahl muss geprüft werden.': 'CATEGORY_CONTROL_UNCONFIRMED',
      'Passender Ölfilter oder Ablassstopfen mit Dichtung nicht eindeutig gefunden.': 'MATERIALS_UNCONFIRMED',
      'Artikelnummer nicht eindeutig gelesen.': 'PART_NUMBER_UNCONFIRMED',
      'Motorölartikel nicht eindeutig.': 'OIL_PRODUCT_UNCONFIRMED',
      'Vorherige Teileauswahl konnte nicht eindeutig zurückgesetzt werden.':'EXTRA_RESET_AMBIGUOUS',
      'Bremsen-Kategorien müssen eindeutig zugeordnet werden.':'BRAKE_CATEGORY_AMBIGUOUS',
      'Mehrere passende Teilevarianten erfordern eine fahrzeugspezifische Prüfung.':'EXTRA_PART_VARIANTS',
      'Teilezuordnung, Einbauseite oder benötigte Stückzahl konnte nicht bestätigt werden.':'EXTRA_PART_EVIDENCE_MISSING',
      'Arbeitszeit für eine gewählte Zusatzleistung konnte nicht eindeutig bestätigt werden.':'EXTRA_LABOUR_UNCONFIRMED',
      'Ölgebinde muss geprüft werden.': 'OIL_PACKAGE_UNCONFIRMED' }[error?.message] || null,
    interaction: /locator\.click: Timeout/.test(error?.message || '') ? 'click'
      : /locator\.check: Timeout/.test(error?.message || '') ? 'check'
      : /locator\.waitFor: Timeout/.test(error?.message || '') ? 'wait' : 'other',
    controlError: /not a checkbox|not a radio/i.test(error?.message || '') ? 'UNSUPPORTED_NATIVE_CHECK'
      : /strict mode violation/i.test(error?.message || '') ? 'AMBIGUOUS_CONTROL' : null,
    pointerIntercepted: /intercepts pointer events/.test(error?.message || ''),
    interceptedElementCategories: interceptedElementCategory(error),
    consentNetworkFailures: consentNetworkFailures.slice(0, 10) }));
  const browser = await chromium.launch({ headless: true, timeout: 30000,
    args:['--js-flags=--max-old-space-size=128'] }).catch(error => { reportFailure(error); throw error; });
  const context = await browser.newContext();
  // Keep the free service's memory available for catalogue and labour data.
  // Product names, prices, fitment badges and image alt labels remain in the
  // document; only decorative binary payloads are omitted. Scripts, styles,
  // account requests and verification controls keep their normal behavior.
  await context.route('**/*',route=>{
    const kind=route.request().resourceType();
    return ['image','media','font'].includes(kind)?route.abort():route.continue();
  });
  let page = await context.newPage();
  const loginResponses = [];
  let loginRequestFailed = false;
  page.on('response', response => {
    const request = response.request();
    const host = new URL(response.url()).hostname;
    if (/(^|\.)usercentrics\.(eu|com)$/.test(host) && response.status() >= 400) {
      consentNetworkFailures.push({ host, status: response.status() });
    }
    if (stage === 'login-submit' && request.method() === 'POST' && new URL(response.url()).origin === DSTORE) {
      loginResponses.push(response.status());
    }
  });
  page.on('requestfailed', request => {
    const host = new URL(request.url()).hostname;
    if (/(^|\.)usercentrics\.(eu|com)$/.test(host)) {
      const reason = request.failure()?.errorText || '';
      consentNetworkFailures.push({ host, error: /^net::ERR_[A-Z_]+$/.test(reason) ? reason : 'NETWORK_ERROR' });
    }
    if (stage === 'login-submit' && request.method() === 'POST' && new URL(request.url()).origin === DSTORE) loginRequestFailed = true;
  });
  page.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(30000);
  const deadline = setTimeout(() => context.close().catch(() => {}), 420000);
  try {
    stage = 'login-page';
    await page.goto(`${DSTORE}/dch-ax/login`, { waitUntil: 'domcontentloaded' });
    stage = 'consent';
    let consentHandled = await rejectVisibleCookieConsent(page, true);
    stage = 'login-input';
    const username = page.locator('input[name="userName"]');
    const password = page.locator('input[type="password"]');
    await username.fill(credentials.username);
    await username.press('Tab');
    await password.fill(credentials.password);
    await password.press('Tab');
    // Consent can appear after the initial form render. Resolve the visible
    // rejection control again after entry; never force-click through overlays.
    if (!consentHandled) consentHandled = await rejectVisibleCookieConsent(page);
    const loginButton = page.getByRole('button', { name: 'Einloggen', exact: true });
    console.info(JSON.stringify({ component: 'supplier-login-ready',
      usernameHasOuterWhitespace: credentials.username !== credentials.username.trim(),
      passwordHasOuterWhitespace: credentials.password !== credentials.password.trim(),
      invalidInputCount: await page.locator('input:invalid').count(),
      loginButtonEnabled: await loginButton.isEnabled() }));
    stage = 'login-submit';
    try {
      await loginButton.click();
    } catch (error) {
      // A late Usercentrics layer can appear after the readiness check.
      // Retry once only after its normal visible consent controls were used.
      if (!/intercepts pointer events/.test(error?.message || '')
        || !interceptedElementCategory(error).includes('usercentrics')
        || !await rejectVisibleCookieConsent(page)) throw error;
      await loginButton.click();
    }
    await page.getByRole('heading', { name: 'Fahrzeugsuche', exact: true }).waitFor({ timeout: 45000 });
    await checkLogin(page);
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'login-confirmed' }));
    stage = 'vehicle-lookup';
    const vin = page.getByPlaceholder('VIN bzw. Chassis-Nummer', { exact: true });
    await vin.fill(input.vin);
    await vin.press('Enter');
    stage = 'vehicle-vin-confirmation';
    // The account can reopen its previously selected vehicle. The change-
    // vehicle button alone is therefore not evidence that this VIN resolved.
    await page.getByText(input.vin, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
    await page.getByRole('button', { name: 'Fahrzeug ändern', exact: true }).waitFor();
    const text = await visibleText(page);
    if (!text.includes(input.vin)) throw manual('Die Fahrgestellnummer wurde nicht bestätigt.');
    stage = 'vehicle-route-confirmation';
    const vehicleId = new URL(page.url()).pathname.match(/\/vehicle\/V(\d+)M\d+\//)?.[1];
    if (!vehicleId) throw manual('Fahrzeugzuordnung nicht bestätigt.');
    stage = 'vehicle-header-confirmation';
    let vehicle = '';
    let vehicleRegion = page.getByRole('heading', { level: 3 }).first();
    for (let depth = 0; depth < 4; depth++) {
      vehicleRegion = vehicleRegion.locator('..');
      const description = clean(await vehicleRegion.innerText());
      if (description.includes(input.vin) && description.length <= 800) { vehicle = description; break; }
    }
    if (!vehicle) throw manual('Fahrzeugzuordnung nicht bestätigt.');
    const vehicleUrl=page.url();
    const vehicleExtraNames=(input.extras||[]).filter(name=>Object.hasOwn(vehicleServices,name));
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'vehicle-confirmed' }));
    stage = 'materials-tab';
    await clickWithCookieConsent(page,page.getByText('Quick Click', { exact: true }));
    console.info(JSON.stringify({component:'supplier-service-categories', names:await page.locator('p-checkbox')
      .evaluateAll(nodes=>nodes.map(n=>n.innerText.trim()).filter(text=>text&&text.length<100).slice(0,80))}));
    stage = 'materials-filter-category';
    await clickCategory(page, 'Oelfilter');
    stage = 'materials-drain-category';
    await clickCategory(page, 'Ablassschraube Ölwanne');
    stage = 'materials-open-list';
    await clickWithCookieConsent(page,page.getByRole('button', { name: 'Artikel anzeigen', exact: true }));
    stage = 'materials-wait-list';
    await page.locator('[id^="part-detail-"]').first().waitFor();
    // A price response arrives after the product cards. Wait for a displayed
    // retail price rather than copying an incomplete loading state.
    stage = 'materials-wait-retail-prices';
    await page.locator('[id^="part-detail-"]').filter({ hasText: /UVPE:\s*[\d’'.,]+\s*CHF/ }).first().waitFor();
    stage = 'materials-select';
    const parts = await chooseMaterials(page);
    if(vehicleExtraNames.length){stage='additional-materials';const extra=await chooseRequestedMaterials(page,vehicleUrl,vehicleExtraNames);parts.push(...extra.selected);page=extra.page;}
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'materials-confirmed' }));
    stage = 'haynes-open';
    await clickWithCookieConsent(page,page.getByRole('link', { name: 'Haynes Pro', exact: true }));
    const popup = context.waitForEvent('page');
    await clickWithCookieConsent(page,page.getByRole('button', { name: 'Hier geht es zu HaynesPro', exact: true }));
    const haynes = await popup;
    haynes.setDefaultTimeout(20000);
    await haynes.getByText(`TecDoc-Nummer: ${vehicleId}`, { exact: true }).waitFor();
    const haynesOverviewUrl=haynes.url();
    await closeHaynesLaunchDialog(page);
    stage = 'labour-lookup';
    await haynes.getByRole('link', { name: /Arbeitswerte/ }).click();
    await haynes.getByRole('heading', { name: 'Arbeitswerte', exact: true }).waitFor();
    const labourText = await visibleText(haynes);
    console.info(JSON.stringify({component:'supplier-service-operations', names:labourText.split('\n')
      .map(x=>x.trim()).filter(x=>x.length<140&&/Filter|Brems|Zündker|Riemen|Batterie|Getriebe/.test(x)
        &&!/[A-HJ-NPR-Z0-9]{17}/.test(x)).slice(0,60)}));
    const labourHours = parseOilHours(labourText);
    const operation = labourText.match(/Motoröl und Filter wechseln\s*OE\s*:\s*([\w-]+)/)?.[1];
    if (!operation) throw manual('Arbeitsposition konnte nicht eindeutig gelesen werden.');
    const extraLabour=[];
    let expandedLabourText=labourText;
    for(const name of vehicleExtraNames){
      let evidence=operationEvidence(expandedLabourText,vehicleServices[name].operations);
      if(!evidence&&/filter/i.test(vehicleServices[name].category)){
        const filter=haynes.getByText('Filter',{exact:true}).filter({visible:true});
        if(await filter.count()===1){await filter.click();await haynes.getByText(/(?:Innenraum|Luftfilter|Kraftstofffilter).*(?:erneuern|wechseln)/).first().waitFor({timeout:5000}).catch(()=>{});expandedLabourText=await visibleText(haynes);evidence=operationEvidence(expandedLabourText,vehicleServices[name].operations);}
      }
      for(const group of vehicleServices[name].groups||[]){
        if(evidence)break;
        let target=haynes.getByRole('link',{name:group,exact:true}).filter({visible:true});
        if(await target.count()!==1)target=haynes.getByText(group,{exact:true}).filter({visible:true});
        if(await target.count()!==1)continue;
        await target.click();
        await haynes.getByText(new RegExp(vehicleServices[name].operations[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).first().waitFor({timeout:5000}).catch(()=>{});
        expandedLabourText=await visibleText(haynes);evidence=operationEvidence(expandedLabourText,vehicleServices[name].operations);
      }
      if(!evidence)throw manual('Arbeitszeit für eine gewählte Zusatzleistung konnte nicht eindeutig bestätigt werden.');
      extraLabour.push({service:name,...evidence});
    }
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'labour-confirmed' }));
    stage = 'oil-specification';
    await haynes.goto(haynesOverviewUrl,{waitUntil:'domcontentloaded'});
    await haynes.getByRole('link', { name: 'Reparaturdaten', exact: true }).click();
    await haynes.getByRole('link', { name: 'D Schmiermittel und Betriebsflüssigkeiten >', exact: true }).click();
    await haynes.getByRole('heading', { name: 'Schmiermittel und Betriebsflüssigkeiten', exact: true }).waitFor();
    const country = haynes.locator('#selectFilterCountry');
    if (await country.count() === 1) await country.selectOption({ label: 'Schweiz' });
    const lubricants = await visibleText(haynes);
    const engine = lubricants.split(/\nMotor\n/).slice(1).join('\nMotor\n').split(/\nKühlsystem\n/)[0];
    const litres = parseOilCapacity(engine);
    const oilSpecification=engineOilSpecification(engine);
    if(!oilSpecification)throw manual('Die benötigte Ölfreigabe muss individuell geprüft werden.');
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'oil-specification-confirmed' }));
    if(oilSpecification.viscosity!=='0W20'||!/^MB\s+229\.71$/i.test(oilSpecification.approval)){
      stage='oil-approved-product-search';
      const oil=await chooseApprovedEngineOil(page,oilSpecification);
      return {vin:input.vin,vehicle,source:'D-Store / HaynesPro',labourHours,labourOperation:operation,extraLabour,
        materials:[{...oil,quantity:litres},...parts]};
    }
    stage = 'oil-product-search';
    await search(page, '15F6E6');
    stage = 'oil-product-identification';
    const oilEntries = [];
    for (const card of await catalogueCards(page)) {
      if (!await card.isVisible()) continue;
      const article = await completeArticleContainer(card);
      const text = await readCatalogCard(article);
      if (/Artikel Nr\.:\s*15F6E6(?:\s|$)/.test(text)) oilEntries.push(article);
    }
    if (oilEntries.length !== 1) throw manual('Motorölartikel nicht eindeutig.');
    let oilCard = oilEntries[0];
    await rejectVisibleCookieConsent(page, true);
    await closeHaynesLaunchDialog(page);
    const matchingOilDialogs = [];
    for (const dialog of await page.getByRole('dialog').filter({ visible: true }).all()) {
      if (/Artikel Nr\.:\s*15F6E6(?:\s|$)/.test(await dialog.innerText())) matchingOilDialogs.push(dialog);
    }
    if (matchingOilDialogs.length === 1) oilCard = matchingOilDialogs[0];
    stage = 'oil-product-details';
    const moreDetails = oilCard.getByRole('button', { name: 'Mehr Details', exact: true }).filter({ visible: true });
    if (await moreDetails.count() === 1) {
      try { await moreDetails.click(); }
      catch (error) {
        if (!/intercepts pointer events/.test(error?.message || '')
          || !interceptedElementCategory(error).includes('usercentrics')
          || !await rejectVisibleCookieConsent(page)) throw error;
        await moreDetails.click();
      }
    }
    stage = 'oil-approval-confirmation';
    await oilCard.getByText('Herstellerfreigabe: MB 229.71', { exact: true }).waitFor();
    await waitForRetailPrice(oilCard);
    const oilText = await readCatalogCard(oilCard);
    stage = 'oil-package-confirmation';
    if (!oilPackageConfirmed(oilText)) throw manual('Ölgebinde muss geprüft werden.');
    return { vin: input.vin, vehicle, source: 'D-Store / HaynesPro', labourHours, labourOperation: operation,extraLabour,
      materials: [{ kind: 'oil', partNumber: '15F6E6', description: 'Castrol EDGE 0W-20 C5, MB 229.71',
        quantity: litres, unitNetCents: retailPriceCents(oilText), priceBasis: 'retail-ex-vat' }, ...parts] };
  } catch (error) {
    if (stage.startsWith('oil-')) {
      const dialogs = [];
      for (const dialog of await page.getByRole('dialog').filter({ visible: true }).all().catch(() => [])) {
        const text = await dialog.innerText().catch(() => '');
        dialogs.push({ haynesLaunch: /Hier geht es zu HaynesPro/.test(text), oilProduct: /15F6E6/.test(text),
          hasCloseButton: await dialog.getByRole('button', { name: /^(Close|Schliessen|Schließen)$/i }).count() > 0 });
      }
      console.warn(JSON.stringify({ component: 'supplier-oil-dialogs', stage, dialogs }));
    }
    if (stage === 'materials-filter-category' || stage === 'materials-drain-category') {
      const categoryName = stage === 'materials-filter-category' ? 'Oelfilter' : 'Ablassschraube Ölwanne';
      const controls = await page.getByText(categoryName, { exact: true }).locator('..').getByRole('checkbox')
        .evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, role: node.getAttribute('role'),
          type: node.getAttribute('type'), ariaChecked: node.getAttribute('aria-checked'),
          hasNativeInput: !!node.querySelector('input[type="checkbox"]'), parentTag: node.parentElement?.tagName,
          parentClass: String(node.parentElement?.className || '').slice(0, 120) }))).catch(() => []);
      console.warn(JSON.stringify({ component: 'supplier-category-controls', stage, controls }));
      const labelShape = await page.getByText(categoryName, { exact: true }).evaluateAll(nodes => nodes.map(node => ({
        tag: node.tagName, hasFor: !!node.getAttribute('for'), parentTag: node.parentElement?.tagName,
        visible: !!(node.getBoundingClientRect().width && node.getBoundingClientRect().height),
        parentClass: String(node.parentElement?.className || '').slice(0, 120),
        children: Array.from(node.parentElement?.children || []).map(child => ({ tag: child.tagName,
          className: String(child.className || '').slice(0, 100), containsLabel: child.contains(node),
          checkboxCount: child.querySelectorAll('input[type="checkbox"]').length }))
      }))).catch(() => null);
      console.warn(JSON.stringify({ component: 'supplier-category-label', stage, labelShape }));
    }
    if (stage === 'consent') console.warn(JSON.stringify({ component: 'supplier-consent-controls',
      publicButtonLabels: await publicConsentControls(page, credentials).catch(() => []) }));
    if (stage === 'login-submit') {
      // Read only visible text and record fixed booleans, never login values,
      // page contents, URLs, cookies, screenshots or raw browser errors.
      try {
        await checkLogin(page);
        console.warn(JSON.stringify({ component: 'supplier-login',
          loginFormVisible: await page.locator('input[type="password"]').isVisible(),
          searchVisible: await page.getByRole('heading', { name: 'Fahrzeugsuche', exact: true }).isVisible(),
          invalidInputCount: await page.locator('input:invalid').count(),
          loginButtonEnabled: await page.getByRole('button', { name: 'Einloggen', exact: true }).isEnabled(),
          cookieRejectVisible: await page.getByRole('button', { name: 'Ablehnen', exact: true }).isVisible(),
          pointerIntercepted: /intercepts pointer events/.test(error?.message || ''),
          interceptedElementCategories: interceptedElementCategory(error),
          publicConsentButtonLabels: await publicConsentControls(page, credentials),
          iframeCount: page.frames().length - 1,
          clickTimedOut: /locator\.click: Timeout/.test(error?.message || ''),
          postResponseStatuses: loginResponses.slice(0, 10), loginRequestFailed }));
      } catch (loginError) {
        if (loginError instanceof QuoteError) { reportFailure(loginError); throw loginError; }
      }
    }
    reportFailure(error);
    throw error;
  } finally {
    clearTimeout(deadline);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
