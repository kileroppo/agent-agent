import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicPdfReader } from '../src/public-pdf-reader.js';
import { PublicWebTransport } from '../src/public-web-transport.js';

test('公开 PDF 复用 DNS 固定解析、拒绝跳转并返回来源哈希', async () => {
  const requests = [];
  const reader = new PublicPdfReader({
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    transport:{
      pinsResolvedAddress:true,
      async fetch(url, options) {
        requests.push({ url, options });
        return new Response(Buffer.from('%PDF-1.7\nfixture'), {
          status:200,
          headers:{ 'content-type':'application/pdf' },
        });
      },
    },
    runImpl:async () => '可读取的公开 PDF 正文',
  });
  const output = await reader.read({ sourceUrl:'https://example.com/report.pdf?token=redacted' });
  assert.equal(output.sourceRef, 'https://example.com/report.pdf');
  assert.match(output.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(output.validation.dnsPinned, true);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.resolvedAddress, '203.0.113.10');
});

test('公开 PDF 在联网前拒绝内网、IPv4映射IPv6和DNS重绑定', async () => {
  let fetches = 0;
  for (const sourceUrl of [
    'http://127.0.0.1/a.pdf',
    'http://[::ffff:a00:1]/a.pdf',
    'http://service.internal/a.pdf',
  ]) {
    const reader = new PublicPdfReader({
      fetchImpl:async () => { fetches += 1; },
    });
    await assert.rejects(() => reader.read({ sourceUrl }), { code:'source_not_public' });
  }
  const rebound = new PublicPdfReader({
    lookupImpl:async () => [
      { address:'203.0.113.10', family:4 },
      { address:'10.0.0.8', family:4 },
    ],
    fetchImpl:async () => { fetches += 1; },
  });
  await assert.rejects(() => rebound.read({ sourceUrl:'https://example.com/a.pdf' }), {
    code:'source_not_public',
  });
  assert.equal(fetches, 0);
});

test('公开 PDF 拒绝忽略 resolvedAddress 的原生 fetch，并由 curl --resolve 固定真实连接目标', async () => {
  let unsafeFetches = 0;
  const unsafe = new PublicPdfReader({
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    transport:{
      async fetch() { unsafeFetches += 1; },
    },
  });
  await assert.rejects(
    () => unsafe.read({ sourceUrl:'https://example.com/report.pdf' }),
    { code:'transport_unavailable' },
  );
  assert.equal(unsafeFetches, 0);

  const calls = [];
  const transport = new PublicWebTransport({
    lookupImpl:async () => { throw new Error('已有固定地址时不得二次 DNS'); },
    run:async (_command, args) => {
      calls.push(args);
      return Buffer.from([
        'HTTP/1.1 200 OK',
        'content-type: application/pdf',
        '',
        '%PDF-1.7\nfixture',
      ].join('\r\n'));
    },
  });
  const safe = new PublicPdfReader({
    transport,
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    runImpl:async () => '固定连接读取到的 PDF 正文',
  });
  const output = await safe.read({ sourceUrl:'https://example.com/report.pdf' });
  assert.equal(output.validation.dnsPinned, true);
  const resolveIndex = calls[0].indexOf('--resolve');
  assert.notEqual(resolveIndex, -1);
  assert.equal(calls[0][resolveIndex + 1], 'example.com:443:203.0.113.10');
});

test('公开 PDF 流超过8MB时立即取消，不先把整个响应读入内存', async () => {
  let cancelled = 0;
  let pulls = 0;
  const reader = new PublicPdfReader({
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    transport:{
      pinsResolvedAddress:true,
      async fetch() {
        return new Response(new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(5 * 1024 * 1024).fill(1));
          },
          cancel() { cancelled += 1; },
        }), {
          status:200,
          headers:{ 'content-type':'application/pdf' },
        });
      },
    },
  });
  await assert.rejects(
    () => reader.read({ sourceUrl:'https://example.com/large.pdf' }),
    { code:'content_too_large' },
  );
  assert.equal(pulls <= 3, true);
  assert.equal(cancelled, 1);
});

test('server同构组合允许1–8MB PDF，超过8MB在调用转换器前中止', async () => {
  const requestOptions = [];
  let converted = 0;
  const twoMegabytePdf = Buffer.alloc(2 * 1024 * 1024, 1);
  Buffer.from('%PDF-1.7\n').copy(twoMegabytePdf);
  const transport = new PublicWebTransport({
    run:async (_command, args, options) => {
      requestOptions.push({ args, options });
      return Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\n\r\n'),
        twoMegabytePdf,
      ]);
    },
  });
  const reader = new PublicPdfReader({
    transport,
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    runImpl:async () => { converted += 1; return '2MB PDF 可读正文'; },
  });
  const output = await reader.read({ sourceUrl:'https://example.com/two-megabytes.pdf' });
  assert.equal(output.bytes, twoMegabytePdf.length);
  assert.equal(converted, 1);
  assert.equal(
    requestOptions[0].args[requestOptions[0].args.indexOf('--max-filesize') + 1],
    String(8 * 1024 * 1024),
  );

  const oversizedTransport = new PublicWebTransport({
    run:async () => {
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
      Buffer.from('%PDF-1.7\n').copy(oversized);
      return Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\n\r\n'),
        oversized,
      ]);
    },
  });
  const oversized = new PublicPdfReader({
    transport:oversizedTransport,
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    runImpl:async () => { converted += 1; return '不应调用'; },
  });
  await assert.rejects(
    () => oversized.read({ sourceUrl:'https://example.com/too-large.pdf' }),
    /超过传输上限/,
  );
  assert.equal(converted, 1);
});
