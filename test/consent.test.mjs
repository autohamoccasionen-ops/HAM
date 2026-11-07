import test from 'node:test';
import assert from 'node:assert/strict';
import { saveEssentialConsentInPage, consentWithFallback } from '../browser-provider.mjs';

async function withCmp(cmp, run) {
  const previous = globalThis.window;
  globalThis.window = { __ucCmp: cmp };
  try { await run(); }
  finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}

test('cookie API records a rejection before closing, without enabling optional cookies', async () => {
  const calls = [];
  await withCmp({ isInitialized: async () => true, isAgeVerificationRequired: async () => false,
    isConsentRequired: async () => true, denyAllConsents: async () => calls.push('deny'),
    saveConsents: async type => calls.push(type), closeCmp: async () => calls.push('close') }, async () => {
    assert.equal(await saveEssentialConsentInPage(), 'essential-only-saved');
    assert.deepEqual(calls, ['deny', 'IMPLICIT', 'close']);
  });
});

test('cookie API does not dismiss an age-verification wall or overwrite an existing choice', async () => {
  for (const [ageRequired, consentRequired, expected] of [[true, true, 'manual-required'], [false, false, 'not-required']]) {
    await withCmp({ isInitialized: async () => true, isAgeVerificationRequired: async () => ageRequired,
      isConsentRequired: async () => consentRequired, denyAllConsents: async () => assert.fail('must not alter consent') }, async () => {
      assert.equal(await saveEssentialConsentInPage(), expected);
    });
  }
});

test('failed consent saving leaves the overlay in place and propagates the error', async () => {
  await withCmp({ isInitialized: async () => true, denyAllConsents: async () => {},
    saveConsents: async () => { throw new Error('save failed'); }, closeCmp: async () => assert.fail('must not close') }, async () => {
    await assert.rejects(saveEssentialConsentInPage, /save failed/);
  });
});

test('an unresponsive privacy SDK times out without proceeding to consent or closing', async () => {
  await withCmp({ isInitialized: () => new Promise(() => {}),
    denyAllConsents: async () => assert.fail('must not proceed'), closeCmp: async () => assert.fail('must not close') }, async () => {
    await assert.rejects(() => saveEssentialConsentInPage(10), /CMP_TIMEOUT_initialize/);
  });
});

test('visible cookie controls take precedence over an unresponsive SDK', async () => {
  assert.equal(await consentWithFallback(async () => true, async () => assert.fail('SDK unnecessary')), true);
});

test('a late visible cookie dialog can recover from initialization timeout', async () => {
  let checks = 0;
  assert.equal(await consentWithFallback(async () => ++checks === 2,
    async () => { throw new Error('CMP_TIMEOUT_initialize'); }), true);
  assert.equal(checks, 2);
});

test('partial consent saves and verification requirements never trigger a fallback click', async () => {
  for (const outcome of ['CMP_TIMEOUT_save', 'manual-required']) {
    let checks = 0;
    await assert.rejects(() => consentWithFallback(async () => { ++checks; return false; }, async () => {
      if (outcome === 'manual-required') return outcome;
      throw new Error(outcome);
    }));
    assert.equal(checks, 1);
  }
});
