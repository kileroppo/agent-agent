import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  PublicDynamicWebReader,
  runControlledChrome,
} from '../src/public-dynamic-web-reader.ts';

test('动态公开页只给固定 Chrome 参数、临时 Profile 和单一受控 URL', async () => {
  const calls = [];
  const reader = new PublicDynamicWebReader({
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    runImpl:async (command, args, options) => {
      calls.push({ command, args, options });
      return '<html><head><title>动态结果</title></head><body><main>脚本渲染后的正文</main></body></html>';
    },
  });
  const output = await reader.read({ sourceUrl:'https://example.com/app' });
  assert.equal(output.title, '动态结果');
  assert.match(output.text, /脚本渲染后的正文/);
  assert.equal(output.validation.javascriptRendered, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /Google Chrome$/);
  assert.equal(calls[0].args.at(-1), 'about:blank');
  assert.equal(calls[0].options.sourceUrl, 'https://example.com/app');
  assert.equal(calls[0].args.some((arg) => arg.startsWith('--proxy-server=http://127.0.0.1:')), true);
  assert.equal(calls[0].args.some((arg) => arg.startsWith('--user-data-dir=')), true);
});

test('动态公开页在启动 Chrome 前拒绝本机和内网 URL', async () => {
  let runs = 0;
  const reader = new PublicDynamicWebReader({
    runImpl:async () => { runs += 1; return ''; },
  });
  await assert.rejects(() => reader.read({ sourceUrl:'http://localhost:4321/private' }), {
    code:'source_not_public',
  });
  assert.equal(runs, 0);
});

test('隔离 fake CDP 在页面加载后只放行同源只读请求', async () => {
  const child = fakeChromeChild();
  const protocol = fakeProtocol();
  const html = await runControlledChrome('fake-chrome', ['--headless=new', 'about:blank'], {
    timeoutMs:100,
    maxBuffer:1024 * 1024,
    sourceUrl:'https://example.com/app',
    spawnImpl:() => child,
    pageTargetWebsocketUrlImpl:async () => 'ws://fake-page',
    connectImpl:async () => protocol,
  });
  assert.match(html, /safe/);
  assert.deepEqual(protocol.calls.filter(({ method }) => method.startsWith('Fetch.')), [
    { method:'Fetch.enable', params:{ patterns:[{ urlPattern:'*', requestStage:'Request' }] } },
    { method:'Fetch.continueRequest', params:{ requestId:'same-origin-get' } },
    { method:'Fetch.failRequest', params:{ requestId:'write', errorReason:'BlockedByClient' } },
    { method:'Fetch.failRequest', params:{ requestId:'cross-origin', errorReason:'BlockedByClient' } },
  ]);
  assert.equal(child.killed, true);
  assert.equal(protocol.closed, true);
});

test('隔离 fake CDP 的加载信号超时不会在导航等待时泄漏 rejection', async () => {
  const child = fakeChromeChild();
  const protocol = fakeProtocol({ loadEvent:false, delayedNavigation:true });
  const html = await runControlledChrome('fake-chrome', ['--headless=new', 'about:blank'], {
    timeoutMs:100,
    maxBuffer:1024 * 1024,
    sourceUrl:'https://example.com/app',
    spawnImpl:() => child,
    pageTargetWebsocketUrlImpl:async () => 'ws://fake-page',
    connectImpl:async () => protocol,
  });
  assert.match(html, /safe/);
  assert.equal(child.killed, true);
  assert.equal(protocol.closed, true);
});

function fakeChromeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  queueMicrotask(() => child.stderr.emit('data', 'DevTools listening on ws://fake-browser/devtools/browser/fake'));
  return child;
}

function fakeProtocol({ loadEvent = true, delayedNavigation = false } = {}) {
  const listeners = new Map();
  return {
    calls:[],
    closed:false,
    onEvent(method, handler) {
      listeners.set(method, handler);
    },
    waitForEvent(method) {
      if (method === 'Page.loadEventFired' && !loadEvent) {
        return Promise.reject(new Error('simulated load event timeout'));
      }
      return new Promise((resolve) => listeners.set(method, resolve));
    },
    async command(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'Page.navigate') {
        if (delayedNavigation) await new Promise((resolve) => setImmediate(resolve));
        const paused = listeners.get('Fetch.requestPaused');
        paused({ request:{ method:'GET', url:'https://example.com/app/data' }, requestId:'same-origin-get' });
        paused({ request:{ method:'POST', url:'https://example.com/app/write' }, requestId:'write' });
        paused({ request:{ method:'GET', url:'https://outside.example/data' }, requestId:'cross-origin' });
        if (loadEvent) listeners.get('Page.loadEventFired')({});
      }
      if (method === 'Runtime.evaluate') return { result:{ value:'<html><body>safe</body></html>' } };
      return {};
    },
    close() {
      this.closed = true;
    },
  };
}
