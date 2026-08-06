import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspaceFile } from './workspace-path-guard.js';

const DEFAULT_BINARIES = Object.freeze({
  pandoc:'/opt/homebrew/bin/pandoc',
  // Callers may inject an audited binary map; the default must remain a
  // machine-independent, standard application path.
  soffice:'/Applications/LibreOffice.app/Contents/MacOS/soffice',
  pdftotext:'/opt/homebrew/bin/pdftotext',
  textutil:'/usr/bin/textutil',
});

export class OfficeDocumentAdapter {
  constructor({ binaries = DEFAULT_BINARIES, runImpl = runCommand } = {}) {
    this.binaries = Object.freeze({ ...binaries });
    this.run = runImpl;
  }

  async writeDocx(context) {
    return this.#writeDocument(context, 'docx');
  }

  async writeXlsx(context) {
    return this.#writeDocument(context, 'xlsx');
  }

  async writePdf(context) {
    return this.#writeDocument(context, 'pdf');
  }

  async #writeDocument({ access, input, workspaceRoot }, format) {
    const target = await safeWorkspaceTarget(workspaceRoot, access?.relativePath, format);
    const temporaryDirectory = await fs.mkdtemp(path.join(await fs.realpath(workspaceRoot), '.m5-office-'));
    try {
      if (format === 'docx') await this.#generateDocx(input, target, temporaryDirectory);
      if (format === 'xlsx') await this.#generateXlsx(input, target, temporaryDirectory);
      if (format === 'pdf') await this.#generatePdf(input, target, temporaryDirectory);
      const bytes = await validateFile(target, format);
      const validation = await this.#validateReadable(target, format, temporaryDirectory);
      const checksum = crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex');
      return Object.freeze({
        filePath:target,
        relativePath:access.relativePath,
        mimeType:mimeType(format),
        bytes,
        checksum,
        validation:Object.freeze({
          exists:true,
          readable:true,
          nonEmpty:true,
          workspaceRestricted:true,
          ...validation,
        }),
      });
    } finally {
      await fs.rm(temporaryDirectory, { recursive:true, force:true });
    }
  }

  async #generateDocx(input, target, temporaryDirectory) {
    const markdown = requiredMarkdown(input);
    const markdownPath = path.join(temporaryDirectory, 'source.md');
    await fs.writeFile(markdownPath, markdown, { mode:0o600, flag:'wx' });
    await this.run(this.binaries.pandoc, [
      '--from=gfm',
      '--to=docx',
      `--metadata=title:${safeTitle(input?.title)}`,
      '--output',
      target,
      markdownPath,
    ], commandOptions());
  }

  async #generateXlsx(input, target, temporaryDirectory) {
    const rows = normalizedRows(input?.rows || input?.sheets?.[0]?.rows);
    const csvPath = path.join(temporaryDirectory, 'source.csv');
    await fs.writeFile(csvPath, rows.map(csvRow).join('\n'), { mode:0o600, flag:'wx' });
    await this.#soffice([
      '--convert-to', 'xlsx:Calc MS Excel 2007 XML',
      '--outdir', temporaryDirectory,
      csvPath,
    ], temporaryDirectory);
    await safeReplace(path.join(temporaryDirectory, 'source.xlsx'), target);
  }

  async #generatePdf(input, target, temporaryDirectory) {
    const docxPath = path.join(temporaryDirectory, 'source.docx');
    await this.#generateDocx(input, docxPath, temporaryDirectory);
    await this.#soffice([
      '--convert-to', 'pdf',
      '--outdir', temporaryDirectory,
      docxPath,
    ], temporaryDirectory);
    await safeReplace(path.join(temporaryDirectory, 'source.pdf'), target);
  }

  async #validateReadable(target, format, temporaryDirectory) {
    if (format === 'docx') {
      const text = await this.run(this.binaries.textutil, [
        '-convert', 'txt',
        '-stdout',
        target,
      ], commandOptions());
      if (!String(text || '').trim()) throw officeError('DOCX 渲染验证没有可读正文。', 'role_tool_output_invalid');
      return { renderedTextVerified:true };
    }
    if (format === 'pdf') {
      const text = await this.run(this.binaries.pdftotext, [
        '-enc', 'UTF-8',
        '-nopgbrk',
        target,
        '-',
      ], commandOptions());
      if (!String(text || '').trim()) throw officeError('PDF 渲染验证没有可读正文。', 'role_tool_output_invalid');
      return { renderedTextVerified:true };
    }
    const validationDirectory = path.join(temporaryDirectory, 'xlsx-validation');
    await fs.mkdir(validationDirectory);
    await this.#soffice([
      '--convert-to', 'csv',
      '--outdir', validationDirectory,
      target,
    ], temporaryDirectory);
    const csv = await fs.readFile(path.join(validationDirectory, `${path.basename(target, '.xlsx')}.csv`), 'utf8');
    if (!csv.trim()) throw officeError('XLSX 重算验证没有可读单元格。', 'role_tool_output_invalid');
    const formulaErrors = (csv.match(/#(?:REF!|VALUE!|NAME\?|DIV\/0!|N\/A)/g) || []).length;
    if (formulaErrors) throw officeError('XLSX 重算后存在公式错误。', 'role_tool_output_invalid');
    return { recalculated:true, formulaErrors:0 };
  }

  async #soffice(args, temporaryDirectory) {
    const profileDirectory = path.join(temporaryDirectory, 'libreoffice-profile');
    await fs.mkdir(profileDirectory, { recursive:true });
    await this.run(this.binaries.soffice, [
      `-env:UserInstallation=${pathToFileUrl(profileDirectory)}`,
      '--headless',
      ...args,
    ], commandOptions(30_000));
  }
}

export async function officeBinariesAvailable(binaries = DEFAULT_BINARIES) {
  try {
    await Promise.all(Object.values(binaries).map((binary) => fs.access(binary, fsConstants.X_OK)));
    return true;
  } catch {
    return false;
  }
}

async function safeWorkspaceTarget(workspaceRoot, relativePath, expectedExtension) {
  const relative = String(relativePath || '').trim().replaceAll('\\', '/');
  if (path.extname(relative).toLowerCase() !== `.${expectedExtension}`) {
    throw officeError(`办公产物必须使用 .${expectedExtension} 扩展名。`, 'role_tool_input_invalid');
  }
  const { target } = await prepareWorkspaceFile(workspaceRoot, relative);
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) throw officeError('办公产物目标不能是符号链接。', 'workspace_path_denied');
    throw officeError('办公产物目标已存在；请使用新版本相对路径，禁止静默覆盖。', 'workspace_file_exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

async function safeReplace(source, target) {
  const sourceStat = await fs.stat(source);
  if (!sourceStat.isFile() || sourceStat.size < 1) {
    throw officeError('办公转换器没有生成有效文件。', 'role_tool_output_invalid');
  }
  await fs.rename(source, target);
}

async function validateFile(target, format) {
  const bytes = await fs.readFile(target);
  const signatures = {
    docx:Buffer.from('PK'),
    xlsx:Buffer.from('PK'),
    pdf:Buffer.from('%PDF-'),
  };
  if (bytes.length < 16 || !bytes.subarray(0, signatures[format].length).equals(signatures[format])) {
    throw officeError(`${format.toUpperCase()} 文件签名无效。`, 'role_tool_output_invalid');
  }
  return bytes.length;
}

function normalizedRows(value) {
  if (!Array.isArray(value) || !value.length || value.length > 2_000) {
    throw officeError('XLSX 需要 1–2000 行二维表格数据。', 'role_tool_input_invalid');
  }
  return value.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 100) {
      throw officeError('XLSX 每行需要 1–100 个单元格。', 'role_tool_input_invalid');
    }
    return row.map((cell) => {
      const text = String(cell ?? '').replace(/\u0000/g, '').slice(0, 10_000);
      if (/^[=+\-@]/.test(text.trimStart())) {
        throw officeError('XLSX 受控适配器拒绝公式和公式注入前缀。', 'role_tool_input_invalid');
      }
      return text;
    });
  });
}

function csvRow(row) {
  return row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',');
}

function requiredMarkdown(input) {
  const markdown = String(input?.markdown || input?.contents || '').replace(/\u0000/g, '').trim();
  if (!markdown || markdown.length > 500_000) {
    throw officeError('DOCX/PDF 需要非空且不超过 500KB 的 Markdown。', 'role_tool_input_invalid');
  }
  if (
    /!\s*\[/m.test(markdown)
    || /<(?:img|video|audio|source|object|embed|iframe|link|script)\b/i.test(markdown)
    || /\\(?:includegraphics|input|include)\b/i.test(markdown)
  ) {
    throw officeError(
      'DOCX/PDF 首版拒绝 Markdown 资源引用，防止读取本机文件或联网下载。',
      'workspace_resource_denied',
    );
  }
  return `${markdown}\n`;
}

function safeTitle(value) {
  return String(value || '办公交付').replace(/[\r\n]/g, ' ').trim().slice(0, 200) || '办公交付';
}

function mimeType(format) {
  return {
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pdf:'application/pdf',
  }[format];
}

function pathToFileUrl(value) {
  return `file://${encodeURI(value)}`;
}

function commandOptions(timeout = 20_000) {
  return { timeoutMs:timeout, maxBuffer:2 * 1024 * 1024 };
}

function officeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runCommand(command, args, { timeoutMs, maxBuffer } = {}) {
  return new Promise((resolve, reject) => execFile(command, args, {
    encoding:'utf8',
    timeout:timeoutMs,
    maxBuffer,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
