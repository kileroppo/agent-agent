import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OfficeDocumentAdapter } from '../src/office-document-adapter.js';

test('默认 Office 转换器只使用标准应用路径，不引用开发机用户缓存', () => {
  const adapter = new OfficeDocumentAdapter();
  assert.equal(
    adapter.binaries.soffice,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  );
  assert.doesNotMatch(adapter.binaries.soffice, /^\/Users\//);
});

test('DOCX/XLSX/PDF 只通过固定转换器写入 execution workspace 并完成可读性验证', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'm5-office-documents-'));
  const calls = [];
  const adapter = new OfficeDocumentAdapter({
    binaries:{
      pandoc:'/fixed/pandoc',
      soffice:'/fixed/soffice',
      pdftotext:'/fixed/pdftotext',
      textutil:'/fixed/textutil',
    },
    runImpl:async (command, args) => {
      calls.push({ command, args });
      if (command === '/fixed/pandoc') {
        const target = args[args.indexOf('--output') + 1];
        await writeFile(target, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 1)]));
        return '';
      }
      if (command === '/fixed/soffice' && args.includes('xlsx:Calc MS Excel 2007 XML')) {
        const outdir = args[args.indexOf('--outdir') + 1];
        await writeFile(path.join(outdir, 'source.xlsx'), Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 2)]));
        return '';
      }
      if (command === '/fixed/soffice' && args.includes('pdf')) {
        const outdir = args[args.indexOf('--outdir') + 1];
        await writeFile(path.join(outdir, 'source.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]));
        return '';
      }
      if (command === '/fixed/soffice' && args.includes('csv')) {
        const outdir = args[args.indexOf('--outdir') + 1];
        const input = args.at(-1);
        await writeFile(path.join(outdir, `${path.basename(input, '.xlsx')}.csv`), '标题,状态\n任务,完成\n');
        return '';
      }
      if (command === '/fixed/textutil' || command === '/fixed/pdftotext') return '可读正文';
      throw new Error(`unexpected command: ${command}`);
    },
  });
  const docx = await adapter.writeDocx(context(workspace, 'deliverables/report.docx', {
    title:'测试报告',
    markdown:'# 测试报告\n\n正文',
  }));
  const xlsx = await adapter.writeXlsx(context(workspace, 'deliverables/report.xlsx', {
    rows:[['任务', '状态'], ['验收', '完成']],
  }));
  const pdf = await adapter.writePdf(context(workspace, 'deliverables/report.pdf', {
    title:'测试报告',
    markdown:'# 测试报告\n\n正文',
  }));
  assert.equal((await readFile(docx.filePath)).subarray(0, 2).toString(), 'PK');
  assert.equal((await readFile(xlsx.filePath)).subarray(0, 2).toString(), 'PK');
  assert.equal((await readFile(pdf.filePath)).subarray(0, 5).toString(), '%PDF-');
  assert.equal(xlsx.validation.recalculated, true);
  assert.equal(xlsx.validation.formulaErrors, 0);
  assert.deepEqual([...new Set(calls.map((call) => call.command))].sort(), [
    '/fixed/pandoc',
    '/fixed/pdftotext',
    '/fixed/soffice',
    '/fixed/textutil',
  ]);
});

test('Office 适配器拒绝路径逃逸、符号链接与 XLSX 公式注入', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'm5-office-safe-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'm5-office-outside-'));
  await mkdir(path.join(workspace, 'links'));
  await symlink(outside, path.join(workspace, 'links', 'outside'));
  const adapter = new OfficeDocumentAdapter({ runImpl:async () => '' });
  await assert.rejects(
    () => adapter.writeDocx(context(workspace, '../outside.docx', { markdown:'# no' })),
    { code:'workspace_path_denied' },
  );
  await assert.rejects(
    () => adapter.writeDocx(context(workspace, 'links/outside/a.docx', { markdown:'# no' })),
    /符号链接/,
  );
  await assert.rejects(
    () => adapter.writeDocx(context(workspace, 'links/outside/newdir/a.docx', { markdown:'# no' })),
    /符号链接/,
  );
  await assert.rejects(() => access(path.join(outside, 'newdir')), { code:'ENOENT' });
  await assert.rejects(
    () => adapter.writeXlsx(context(workspace, 'report.xlsx', { rows:[['=HYPERLINK("http://bad")']] })),
    { code:'role_tool_input_invalid' },
  );
});

test('DOCX/PDF 在调用 Pandoc 前拒绝本机、联网和父级 Markdown 资源引用', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'm5-office-resource-safe-'));
  let commands = 0;
  const adapter = new OfficeDocumentAdapter({
    runImpl:async () => { commands += 1; },
  });
  for (const [index, markdown] of [
    '![本机](/Users/example/secret.png)',
    '![文件](file:///tmp/secret.png)',
    '![联网](https://example.com/tracker.png)',
    '![父级](../outside.png)',
    '<img src="data:image/png;base64,AAA">',
  ].entries()) {
    await assert.rejects(
      () => adapter.writeDocx(context(workspace, `out/report-${index}.docx`, { markdown })),
      { code:'workspace_resource_denied' },
    );
  }
  assert.equal(commands, 0);
});

function context(workspaceRoot, relativePath, input) {
  return { access:{ relativePath }, input, workspaceRoot };
}
