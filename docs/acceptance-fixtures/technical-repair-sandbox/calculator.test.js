import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from './calculator.js';

test('加法返回两个数字的和', () => {
  assert.equal(add(2, 3), 5);
});
