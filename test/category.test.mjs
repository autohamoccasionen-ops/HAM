import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryCheckboxState } from '../browser-provider.mjs';

test('category selection supports native and ARIA checkboxes without guessing unknown state', () => {
  for (const checked of [true, false]) {
    assert.equal(categoryCheckboxState({ type: 'checkbox', checked }), checked);
    assert.equal(categoryCheckboxState({ querySelector: () => ({ checked }) }), checked);
    assert.equal(categoryCheckboxState({ getAttribute: () => String(checked) }), checked);
  }
  assert.equal(categoryCheckboxState({ getAttribute: () => 'mixed' }), null);
  assert.equal(categoryCheckboxState({ getAttribute: () => null }), null);
});
