import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMaterials } from '../browser-provider.mjs';

function supplierCard({ seal = 'mit Dichtring', vin = true } = {}) {
  let opened = 0;
  const text = () => 'Artikel Nr.: TEST-PLUG\nVerschlussschraube, Ölwanne\nELRING\n'
    + (vin ? 'VIN\n' : '') + 'UVPE: 13.46 CHF exkl. MwSt.\n'
    + (opened ? seal + '\nbenötigte Stückzahl: 1' : 'Mehr Details');
  const root = { get innerText() { return text(); }, querySelectorAll: () => [] };
  const details = { count: async () => 1, filter() { return this; }, click: async () => { opened++; } };
  const article = {
    filter() { return this; }, waitFor: async () => {},
    evaluate: async fn => fn(root),
    getByRole: () => details,
    getByText: () => ({ first: () => ({ waitFor: async () => {} }) })
  };
  const page = {
    evaluate: async () => [{ id: 'part-detail-test', depth: 1, text: text(), labels: [], imageLabels: [] }],
    // The details node is collapsed; only its enclosing card is visible.
    locator: () => ({ locator: () => article, isVisible: async () => false }),
    waitForTimeout: async () => {}
  };
  return { page, opened: () => opened };
}

test('collapsed product details are opened before requiring the drain-plug seal', async () => {
  const card = supplierCard();
  const [part] = await chooseMaterials(card.page, ['drain-plug']);
  assert.equal(card.opened(), 1);
  assert.equal(part.partNumber, 'TEST-PLUG');
  assert.equal(part.unitNetCents, 1346);
  assert.equal(part.quantity, 1);
});

test('opening details still cannot substitute a missing seal or VIN fitment', async () => {
  for (const options of [{ seal: 'ohne Dichtring' }, { vin: false }]) {
    await assert.rejects(chooseMaterials(supplierCard(options).page, ['drain-plug']),
      { code: 'MANUAL_REVIEW_REQUIRED' });
  }
});
