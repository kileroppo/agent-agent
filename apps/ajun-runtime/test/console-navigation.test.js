import test from 'node:test';
import assert from 'node:assert/strict';

import { createConsoleNavigation } from '../public/console-navigation.js';

test('任务 pathname 首次打开记录页，切换其他 hash 时清除详情 pathname', () => {
  let hash = '';
  let pathname = '/tasks/11111111-1111-4111-8111-111111111111';
  const activated = [];
  const replacements = [];
  const navigation = createConsoleNavigation({
    getHash:() => hash,
    getPathname:() => pathname,
    replaceLocation:(value) => replacements.push(value),
    activate:(name) => activated.push(name),
  });

  assert.equal(navigation.initialize(), true);
  assert.deepEqual(activated, ['records']);

  hash = '#employees';
  navigation.locationChanged();
  assert.deepEqual(activated, ['records', 'employees']);
  assert.deepEqual(replacements, ['/#employees']);

  pathname = '/';
  hash = '#runs';
  navigation.locationChanged();
  assert.deepEqual(activated, ['records', 'employees', 'records']);
});

test('后台数据刷新不会重复激活当前页面', () => {
  const activated = [];
  const navigation = createConsoleNavigation({
    getHash:() => '#records',
    getPathname:() => '/',
    activate:(name) => activated.push(name),
  });

  assert.equal(navigation.initialize(), true);
  assert.equal(navigation.initialize(), false);
  assert.deepEqual(activated, ['records']);
});
