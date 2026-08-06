import test from 'node:test';
import assert from 'node:assert/strict';

import { createConsoleNavigation } from '../public/console-navigation.js';

test('任务详情首次打开记录页，但侧栏 hash 可以切换到其他页面', () => {
  let hash = '';
  const activated = [];
  const navigation = createConsoleNavigation({
    selectedTaskId:'task-1',
    getHash:() => hash,
    activate:(name) => activated.push(name),
  });

  assert.equal(navigation.initialize(), true);
  assert.deepEqual(activated, ['records']);

  hash = '#employees';
  navigation.locationChanged();
  assert.deepEqual(activated, ['records', 'employees']);
});

test('后台数据刷新不会重复激活当前页面', () => {
  const activated = [];
  const navigation = createConsoleNavigation({
    selectedTaskId:'',
    getHash:() => '#records',
    activate:(name) => activated.push(name),
  });

  assert.equal(navigation.initialize(), true);
  assert.equal(navigation.initialize(), false);
  assert.deepEqual(activated, ['records']);
});
