import { QuoteError, parseOilCapacity, parseOilHours, retailPriceCents } from './quote.mjs';

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
  const names = ['MAHLE', 'MANN-FILTER', 'BOSCH', 'ELRING', 'FEBI BILSTEIN', 'HERTH+BUSS ELPARTS'];
  const normalized = labels.map(label => String(label || '').trim().toUpperCase());
  const brands = names.filter(name => normalized.some(label => [name, `${name} LOGO`, `LOGO ${name}`].includes(label)));
  if (brands.length === 1 && !result.includes(brands[0])) result += '\n' + brands[0];
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
        if (!entry.text.includes(brand) || !(kind === 'filter' ? /Ölfilter/.test(entry.text) : /Verschlussschraube, Ölwanne/.test(entry.text))) continue;
        let candidate = materialCandidate(entry.text, kind);
        if (!candidate) {
          const details = entry.card.getByRole('button', { name: 'Mehr Details', exact: true }).filter({ visible: true });
          if (await details.count() === 1) {
            await details.click();
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

async function selectCategoryByObservedChange(page, row, label) {
  const snapshot = () => row.getByRole('checkbox').evaluateAll(nodes => nodes.map(node => ({
    id: node.id || null, checked: node.type === 'checkbox' ? node.checked
      : node.getAttribute('aria-checked') === 'true' ? true : node.getAttribute('aria-checked') === 'false' ? false : null
  })));
  const before = await snapshot();
  if (before.some(item => !item.id || typeof item.checked !== 'boolean')) return false;
  await label.click();
  for (let attempt = 0; attempt < 5; attempt++) {
    const after = await snapshot();
    const index = uniqueCheckboxChange(before, after);
    if (index !== null) {
      if (after[index].checked) return true;
      // The category was already selected. Restore it through the same label.
      await label.click();
      const restored = await snapshot();
      return restored.length === before.length && restored.every((item, i) => item.id === before[i].id
        && item.checked === (i === index ? true : before[i].checked));
    }
    await page.waitForTimeout(100);
  }
  return false;
}

async function clickCategory(page, name) {
  const panel = page.getByRole('tabpanel', { name: 'Quick Click', exact: true });
  const scope = await panel.count() === 1 ? panel : page;
  // The same name also appears in the navigation tree. Its DIV is not the
  // Quick Click checkbox label, which is rendered inside p-checkbox.
  let label = scope.locator('p-checkbox').getByText(name, { exact: true }).filter({ visible: true });
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
    if (await selectCategoryByObservedChange(page, row, label)) return;
    throw manual('Teileauswahl muss geprüft werden.');
  }
  const checkbox = matches.first();
  const checked = () => checkbox.evaluate(categoryCheckboxState);
  const initial = await checked();
  if (initial === null) throw manual('Teileauswahl muss geprüft werden.');
  if (initial) return;
  // Styled tree checkboxes cover the native input with their visible label.
  // Use that normal user-facing target, then verify actual checked state.
  await label.click();
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await checked() === true) return;
    await page.waitForTimeout(100);
  }
  const wrapper = checkbox.locator('..');
  if (await wrapper.isVisible() && await wrapper.getByRole('checkbox').count() === 1) {
    await wrapper.click();
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await checked() === true) return;
      await page.waitForTimeout(100);
    }
  }
  throw manual('Teileauswahl muss geprüft werden.');
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
      'Ölgebinde muss geprüft werden.': 'OIL_PACKAGE_UNCONFIRMED' }[error?.message] || null,
    interaction: /locator\.click: Timeout/.test(error?.message || '') ? 'click'
      : /locator\.check: Timeout/.test(error?.message || '') ? 'check'
      : /locator\.waitFor: Timeout/.test(error?.message || '') ? 'wait' : 'other',
    controlError: /not a checkbox|not a radio/i.test(error?.message || '') ? 'UNSUPPORTED_NATIVE_CHECK'
      : /strict mode violation/i.test(error?.message || '') ? 'AMBIGUOUS_CONTROL' : null,
    consentNetworkFailures: consentNetworkFailures.slice(0, 10) }));
  const browser = await chromium.launch({ headless: true, timeout: 30000 }).catch(error => { reportFailure(error); throw error; });
  const context = await browser.newContext();
  const page = await context.newPage();
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
  const deadline = setTimeout(() => context.close().catch(() => {}), 240000);
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
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'vehicle-confirmed' }));
    stage = 'materials-tab';
    await page.getByText('Quick Click', { exact: true }).click();
    stage = 'materials-filter-category';
    await clickCategory(page, 'Oelfilter');
    stage = 'materials-drain-category';
    await clickCategory(page, 'Ablassschraube Ölwanne');
    stage = 'materials-open-list';
    await page.getByRole('button', { name: 'Artikel anzeigen', exact: true }).click();
    stage = 'materials-wait-list';
    await page.locator('[id^="part-detail-"]').first().waitFor();
    // A price response arrives after the product cards. Wait for a displayed
    // retail price rather than copying an incomplete loading state.
    stage = 'materials-wait-retail-prices';
    await page.locator('[id^="part-detail-"]').filter({ hasText: /UVPE:\s*[\d’'.,]+\s*CHF/ }).first().waitFor();
    stage = 'materials-select';
    const parts = await chooseMaterials(page);
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'materials-confirmed' }));
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
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'labour-confirmed' }));
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
    console.info(JSON.stringify({ component: 'supplier-progress', stage: 'oil-specification-confirmed' }));
    stage = 'oil-product-search';
    await search(page, '15F6E6');
    stage = 'oil-product-identification';
    const oilEntries = [];
    for (const card of await page.locator('[id^="part-detail-"]').all()) {
      if (!await card.isVisible()) continue;
      const article = await completeArticleContainer(card);
      const text = await readCatalogCard(article);
      if (/Artikel Nr\.:\s*15F6E6(?:\s|$)/.test(text)) oilEntries.push(article);
    }
    if (oilEntries.length !== 1) throw manual('Motorölartikel nicht eindeutig.');
    const oilCard = oilEntries[0];
    stage = 'oil-product-details';
    const moreDetails = oilCard.getByRole('button', { name: 'Mehr Details', exact: true }).filter({ visible: true });
    if (await moreDetails.count() === 1) await moreDetails.click();
    stage = 'oil-approval-confirmation';
    await oilCard.getByText('Herstellerfreigabe: MB 229.71', { exact: true }).waitFor();
    const oilText = await readCatalogCard(oilCard);
    stage = 'oil-package-confirmation';
    if (!oilPackageConfirmed(oilText)) throw manual('Ölgebinde muss geprüft werden.');
    return { vin: input.vin, vehicle, source: 'D-Store / HaynesPro', labourHours, labourOperation: operation,
      materials: [{ kind: 'oil', partNumber: '15F6E6', description: 'Castrol EDGE 0W-20 C5, MB 229.71',
        quantity: litres, unitNetCents: retailPriceCents(oilText), priceBasis: 'retail-ex-vat' }, ...parts] };
  } catch (error) {
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
