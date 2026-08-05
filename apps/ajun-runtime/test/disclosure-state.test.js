import test from 'node:test';
import assert from 'node:assert/strict';

import {
  markSyncStarted,
  replaceChildrenPreservingDisclosureState,
  setTextIfChanged,
} from '../public/disclosure-state.js';

test('连接列表刷新后保留外层卡片和嵌套操作区的展开状态', () => {
  const original = [
    disclosure('account:one', true),
    disclosure('account-actions:one', true),
    disclosure('account:two', false),
  ];
  const replacement = [
    disclosure('account:one', false),
    disclosure('account-actions:one', false),
    disclosure('account:two', false),
  ];
  const container = fakeContainer([fakeNode('original', original)]);

  replaceChildrenPreservingDisclosureState(container, [fakeNode('updated', replacement)]);

  assert.equal(replacement[0].open, true);
  assert.equal(replacement[1].open, true);
  assert.equal(replacement[2].open, false);
});

test('连接列表内容未变化时复用现有节点以避免后台同步闪烁', () => {
  const currentNode = fakeNode('same', [disclosure('account:one', true)]);
  const replacementNode = fakeNode('same', [disclosure('account:one', false)]);
  const container = fakeContainer([currentNode]);

  const changed = replaceChildrenPreservingDisclosureState(container, [replacementNode]);

  assert.equal(changed, false);
  assert.equal(container.replaceCount, 0);
  assert.equal(container.childNodes[0], currentNode);
  assert.equal(container.childNodes[0].disclosures[0].open, true);
});

test('后台自动同步不切换顶部状态灯动画', () => {
  const indicator = { className:'sync-indicator synced' };

  const changed = markSyncStarted(indicator, { background:true });

  assert.equal(changed, false);
  assert.equal(indicator.className, 'sync-indicator synced');
});

test('后台同步文字未变化时不重写文本节点', () => {
  let writes = 0;
  let text = '连接正常';
  const element = {
    get textContent() { return text; },
    set textContent(value) { writes += 1; text = value; },
  };

  const changed = setTextIfChanged(element, '连接正常');

  assert.equal(changed, false);
  assert.equal(writes, 0);
});

function disclosure(key, open) {
  return { dataset:{ disclosureKey:key }, open };
}

function fakeNode(markup, disclosures) {
  return {
    markup,
    disclosures,
    isEqualNode(other) {
      return this.markup === other.markup;
    },
  };
}

function fakeContainer(initialNodes) {
  return {
    childNodes:initialNodes,
    replaceCount:0,
    querySelectorAll() {
      return this.childNodes.flatMap((node) => node.disclosures || []);
    },
    replaceChildren(...nodes) {
      this.replaceCount += 1;
      this.childNodes = nodes;
    },
  };
}
