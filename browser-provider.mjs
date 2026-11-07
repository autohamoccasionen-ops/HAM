import { QuoteError, parseOilCapacity, parseOilHours, retailPriceCents } from './quote.mjs';

// Read-only browser integration. No account changes, cart additions, orders,
// offer submission, CAPTCHA solving, trace capture or cookie export.
const DSTORE = 'https://d-store.ch';
const clean = text => String(text).replace(/\u00a0/g, ' ').trim();
const manual = message => new QuoteError('MANUAL_REVIEW_REQUIRED', message);
const invalidLogin = /Falsches Passwort|incorrect username or password|Benutzername.*ungültig|Sitzung ist abgelaufen|(?:Benutzername|Passwort|Zugangsdaten|Anmeldedaten)[^\n]{0,100}(?:falsch|ungültig|nicht korrekt)|(?:falsch|ungültig)[^\n]{0,60}(?:Benutzername|Passwort|Zugangsdaten|Anmeldedaten)/i;

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

export function materialCandidate(text, kind) {
  text = clean(text);
  if (!/\bVIN\b/.test(text) || /Auf Anfrage|ABVERKAUFSARTIKEL|\d+ Stück = 1 Pack/.test(text)) return null;
  if (kind === 'filter' && (!/Ölfilter/.test(text) || !/mit Dichtung/.test(text))) return null;
  if (kind === 'drain-plug' && (!/Verschlussschraube, Ölwanne/.test(text) || !/mit Dichtring|mit Dichtung/.test(text))) return null;
  const quantity = text.match(/benötigte Stückzahl:\s*(\d+)/);
  if (quantity && Number(quantity[1]) !== 1) return null;
  const brand = kind === 'filter' ? ['MAHLE', 'MANN-FILTER', 'BOSCH'].find(value => text.includes(value))
    : ['ELRING', 'FEBI BILSTEIN', 'HERTH+BUSS ELPARTS'].find(value => text.includes(value));
  if (!brand) return null;
  return { kind, partNumber: articleNumber(text), description: `${brand} ${kind === 'filter' ? 'Ölfilter mit Dichtung' : 'Ölablassschraube mit Dichtring'}`,
    quantity: 1, unitNetCents: retailPriceCents(text), priceBasis: 'retail-ex-vat', brand };
}

async function chooseMaterials(page) {
  const cards = await page.locator('[id^="part-detail-"]').all();
  const candidates = [];
  for (const card of cards) {
    const text = await card.innerText();
    for (const kind of ['filter', 'drain-plug']) {
      const result = materialCandidate(text, kind);
      if (result) candidates.push(result);
    }
  }
  return ['filter', 'drain-plug'].map(kind => {
    const priorities = kind === 'filter' ? ['MAHLE', 'MANN-FILTER', 'BOSCH'] : ['ELRING', 'FEBI BILSTEIN', 'HERTH+BUSS ELPARTS'];
    const list = candidates.filter(row => row.kind === kind).sort((a, b) => priorities.indexOf(a.brand) - priorities.indexOf(b.brand));
    if (!list.length) throw manual('Passender Ölfilter oder Ablassstopfen mit Dichtung nicht eindeutig gefunden.');
    const { brand, ...selected } = list[0];
    return selected;
  });
}

async function clickCategory(page, name) {
  const label = page.getByText(name, { exact: true });
  if (await label.count() !== 1) throw manual('Teilekategorie nicht eindeutig.');
  const row = label.locator('..');
  const checkbox = row.getByRole('checkbox');
  if (await checkbox.count() !== 1) throw manual('Teileauswahl muss geprüft werden.');
  await checkbox.check();
}

export async function readQuote(input, credentials) {
  const { chromium } = await import('playwright');
  let stage = 'browser-launch';
  const reportFailure = error => console.warn(JSON.stringify({ component: 'supplier-lookup', stage,
    failure: error instanceof QuoteError ? error.code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'BROWSER_ERROR' }));
  const browser = await chromium.launch({ headless: true }).catch(error => { reportFailure(error); throw error; });
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginResponses = [];
  let loginRequestFailed = false;
  page.on('response', response => {
    const request = response.request();
    if (stage === 'login-submit' && request.method() === 'POST' && new URL(response.url()).origin === DSTORE) {
      loginResponses.push(response.status());
    }
  });
  page.on('requestfailed', request => {
    if (stage === 'login-submit' && request.method() === 'POST' && new URL(request.url()).origin === DSTORE) loginRequestFailed = true;
  });
  page.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(30000);
  const deadline = setTimeout(() => context.close().catch(() => {}), 120000);
  try {
    stage = 'login-page';
    await page.goto(`${DSTORE}/dch-ax/login`, { waitUntil: 'domcontentloaded' });
    const rejectCookies = page.getByRole('button', { name: 'Ablehnen', exact: true });
    if (await rejectCookies.isVisible()) await rejectCookies.click();
    const username = page.locator('input[name="userName"]');
    const password = page.locator('input[type="password"]');
    await username.fill(credentials.username);
    await username.press('Tab');
    await password.fill(credentials.password);
    await password.press('Tab');
    const loginButton = page.getByRole('button', { name: 'Einloggen', exact: true });
    console.info(JSON.stringify({ component: 'supplier-login-ready',
      usernameHasOuterWhitespace: credentials.username !== credentials.username.trim(),
      passwordHasOuterWhitespace: credentials.password !== credentials.password.trim(),
      invalidInputCount: await page.locator('input:invalid').count(),
      loginButtonEnabled: await loginButton.isEnabled() }));
    stage = 'login-submit';
    await loginButton.click();
    await page.getByRole('heading', { name: 'Fahrzeugsuche', exact: true }).waitFor({ timeout: 45000 });
    await checkLogin(page);
    stage = 'vehicle-lookup';
    const vin = page.getByPlaceholder('VIN bzw. Chassis-Nummer', { exact: true });
    await vin.fill(input.vin);
    await vin.press('Enter');
    await page.getByRole('button', { name: 'Fahrzeug ändern', exact: true }).waitFor();
    const text = await visibleText(page);
    if (!text.includes(input.vin)) throw manual('Die Fahrgestellnummer wurde nicht bestätigt.');
    const vehicle = clean(await page.getByRole('heading', { level: 3 }).first().locator('..').innerText());
    const vehicleId = new URL(page.url()).pathname.match(/\/vehicle\/V(\d+)M\d+\//)?.[1];
    if (!vehicleId || !vehicle.includes(input.vin)) throw manual('Fahrzeugzuordnung nicht bestätigt.');
    stage = 'material-selection';
    await page.getByRole('tab', { name: 'Quick Click', exact: true }).click();
    await clickCategory(page, 'Oelfilter');
    await clickCategory(page, 'Ablassschraube Ölwanne');
    await page.getByRole('button', { name: 'Artikel anzeigen', exact: true }).click();
    await page.locator('[id^="part-detail-"]').first().waitFor();
    // A price response arrives after the product cards. Wait for a displayed
    // retail price rather than copying an incomplete loading state.
    await page.getByText('UVPE:', { exact: true }).first().waitFor();
    const parts = await chooseMaterials(page);
    stage = 'haynes-open';
    await page.getByRole('link', { name: 'Haynes Pro', exact: true }).click();
    const popup = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Hier geht es zu HaynesPro', exact: true }).click();
    const haynes = await popup;
    haynes.setDefaultTimeout(20000);
    await haynes.getByText(`TecDoc-Nummer: ${vehicleId}`, { exact: true }).waitFor();
    stage = 'labour-lookup';
    await haynes.getByRole('link', { name: /Arbeitswerte/ }).click();
    await haynes.getByRole('heading', { name: 'Arbeitswerte', exact: true }).waitFor();
    const labourText = await visibleText(haynes);
    const labourHours = parseOilHours(labourText);
    const operation = labourText.match(/Motoröl und Filter wechseln\s*OE\s*:\s*([\w-]+)/)?.[1];
    if (!operation) throw manual('Arbeitsposition konnte nicht eindeutig gelesen werden.');
    stage = 'oil-specification';
    await haynes.getByRole('link', { name: '<Zurück zu Übersicht', exact: true }).click();
    await haynes.getByRole('link', { name: 'Reparaturdaten', exact: true }).click();
    await haynes.getByRole('link', { name: 'D Schmiermittel und Betriebsflüssigkeiten >', exact: true }).click();
    await haynes.getByRole('heading', { name: 'Schmiermittel und Betriebsflüssigkeiten', exact: true }).waitFor();
    const country = haynes.locator('#selectFilterCountry');
    if (await country.count() === 1) await country.selectOption({ label: 'Schweiz' });
    const lubricants = await visibleText(haynes);
    const engine = lubricants.split(/\nMotor\n/).slice(1).join('\nMotor\n').split(/\nKühlsystem\n/)[0];
    const litres = parseOilCapacity(engine);
    // Initial supported catalog mapping. Unmapped approvals are deliberately
    // manual review. Never substitute this oil for an unlisted specification.
    if (!/SAE 0W-20\s+MB 229\.71/.test(engine)) throw manual('Die benötigte Ölfreigabe muss individuell geprüft werden.');
    stage = 'oil-product';
    await search(page, '15F6E6');
    const oilCard = page.locator('[id^="part-detail-"]').filter({ hasText: 'Artikel Nr.: 15F6E6' });
    if (await oilCard.count() !== 1) throw manual('Motorölartikel nicht eindeutig.');
    await oilCard.getByRole('button', { name: 'Mehr Details', exact: true }).click();
    await oilCard.getByText('Herstellerfreigabe: MB 229.71', { exact: true }).waitFor();
    const oilText = await oilCard.innerText();
    if (!/Inhalt \[Liter\]:\s*1\b/.test(oilText) || !/0W20/.test(oilText)) throw manual('Ölgebinde muss geprüft werden.');
    return { vin: input.vin, vehicle, source: 'D-Store / HaynesPro', labourHours, labourOperation: operation,
      materials: [{ kind: 'oil', partNumber: '15F6E6', description: 'Castrol EDGE 0W-20 C5, MB 229.71',
        quantity: litres, unitNetCents: retailPriceCents(oilText), priceBasis: 'retail-ex-vat' }, ...parts] };
  } catch (error) {
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
