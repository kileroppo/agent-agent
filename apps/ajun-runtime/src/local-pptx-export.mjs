#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_ELEMENT_TYPES = new Set(['text', 'shape', 'line', 'image', 'table', 'chart']);
const OFFICE_CJK_FONT = 'Arial Unicode MS';
const ALLOWED_MEDIA_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(requiredArg(args, 'manifest'));
  const outputPath = path.resolve(requiredArg(args, 'output'));
  const qaDirectory = path.resolve(requiredArg(args, 'qa-dir'));
  const artifactEntry = path.resolve(requiredArg(args, 'artifact-entry'));
  const jszipEntry = path.resolve(requiredArg(args, 'jszip-entry'));
  const sharpEntry = path.resolve(requiredArg(args, 'sharp-entry'));

  await assertMissing(outputPath);
  await assertMissing(qaDirectory);
  const projectRoot = path.dirname(manifestPath);
  const manifest = await readJsonFile(manifestPath, 1024 * 1024);
  const pages = await readProjectPages(projectRoot, manifest);
  const { Presentation, PresentationFile, FileBlob } = await import(pathToFileURL(artifactEntry).href);
  const jszipModule = await import(pathToFileURL(jszipEntry).href);
  const JSZip = jszipModule.default || jszipModule;
  const sharpModule = await import(pathToFileURL(sharpEntry).href);
  const sharp = sharpModule.default || sharpModule;
  const presentation = Presentation.create({
    slideSize:{ width:manifest.size[0], height:manifest.size[1] },
  });

  for (const [index, page] of pages.entries()) {
    const slide = presentation.slides.add();
    await addPage({ presentation, slide, page, manifest, projectRoot, pageNumber:index + 1 });
  }

  const sourcePreviewDirectory = path.join(qaDirectory, 'source-pages');
  const renderedPreviewDirectory = path.join(qaDirectory, 'pages');
  const layoutDirectory = path.join(qaDirectory, 'layouts');
  await Promise.all([
    fs.mkdir(sourcePreviewDirectory, { recursive:true, mode:0o700 }),
    fs.mkdir(renderedPreviewDirectory, { recursive:true, mode:0o700 }),
    fs.mkdir(layoutDirectory, { recursive:true, mode:0o700 }),
  ]);
  await exportSlideEvidence(presentation, sourcePreviewDirectory, layoutDirectory);

  const exported = await PresentationFile.exportPptx(presentation);
  const stagingDirectory = await fs.mkdtemp(path.join(path.dirname(outputPath), '.local-pptx-export-'));
  let patchedBytes;
  try {
    const stagingPath = path.join(stagingDirectory, 'unpatched.pptx');
    await exported.save(stagingPath);
    patchedBytes = await patchAndValidatePptx(await fs.readFile(stagingPath), JSZip, pages.length);
    await fs.writeFile(outputPath, patchedBytes, { flag:'wx', mode:0o600 });
  } finally {
    await fs.rm(stagingDirectory, { recursive:true, force:true });
  }

  const imported = await PresentationFile.importPptx(await FileBlob.load(outputPath));
  if (imported.slides.items.length !== pages.length) {
    throw controlledError('PPTX 回读页数与 PPTD 不一致。', 'pptx_roundtrip_page_count_mismatch');
  }
  await exportRenderedEvidence(imported, renderedPreviewDirectory, qaDirectory, sharp);
  const zipValidation = await validatePptx(await fs.readFile(outputPath), JSZip, pages.length);
  const qaFiles = await listRegularFiles(qaDirectory);
  const summary = {
    schemaVersion:'agent.army/local-pptx-export/v1',
    status:'passed',
    slides:pages.length,
    fadeTransitions:zipValidation.fadeTransitions,
    transitionPatchedSlides:zipValidation.fadeTransitions,
    transitionXmlOrderValid:zipValidation.transitionXmlOrderValid,
    zipIntegrityValid:zipValidation.zipIntegrityValid,
    fontParts:zipValidation.fontParts,
    referencedFonts:zipValidation.referencedFonts,
    fontEmbeddingVerified:zipValidation.fontParts > 0,
    fontCompatibilityTypeface:OFFICE_CJK_FONT,
    fontCompatibilityVerified:zipValidation.fontCompatibilityVerified,
    renderedSlides:imported.slides.items.length,
    qaFileCount:qaFiles.length,
    bytes:patchedBytes.length,
    checksum:crypto.createHash('sha256').update(patchedBytes).digest('hex'),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function addPage({ slide, page, manifest, projectRoot, pageNumber }) {
  slide.background.fill = resolveColor(page.background?.color || '#FFFFFF', manifest.theme);
  for (const element of page.elements) {
    if (!ALLOWED_ELEMENT_TYPES.has(element.elementType)) {
      throw controlledError(`第 ${pageNumber} 页包含不支持的元素。`, 'pptd_element_unsupported');
    }
    if (element.elementType === 'text') addText(slide, element, manifest.theme);
    if (element.elementType === 'shape' || element.elementType === 'line') addShape(slide, element, manifest.theme);
    if (element.elementType === 'image') await addImage(slide, element, manifest.theme, projectRoot);
    if (element.elementType === 'table') addTable(slide, element, manifest.theme);
    if (element.elementType === 'chart') addChart(slide, element, manifest.theme);
  }
  const sources = page.elements
    .filter((element) => element.elementType === 'image')
    .map((element) => `- Local workspace asset: ${element.src}`);
  const noteText = [page.notes ? String(page.notes).trim() : '', sources.length ? `[Sources]\n${sources.join('\n')}` : '']
    .filter(Boolean)
    .join('\n\n');
  if (noteText) slide.speakerNotes.textFrame.setText(noteText);
}

function addText(slide, element, theme) {
  const style = resolveTextStyle(element.content?.style, theme);
  const shape = slide.shapes.add({
    geometry:'textbox',
    name:safeName(element.elementId),
    position:position(element.bounds),
    fill:'none',
    line:{ style:'solid', fill:'none', width:0 },
  });
  const paragraphs = richTextParagraphs(element.content?.text);
  shape.text = paragraphs.length > 1 || paragraphs.some((item) => typeof item === 'object')
    ? paragraphs
    : String(paragraphs[0] || '');
  shape.text.style = {
    fontSize:numberOr(style.fontSize, 18),
    typeface:String(style.fontFamily || style.typeface || OFFICE_CJK_FONT),
    bold:style.bold === true,
    color:resolveColor(style.color || '#1F2937', theme),
    alignment:horizontalAlignment(element.content?.align?.[0]),
    verticalAlignment:verticalAlignment(element.content?.align?.[1]),
    autoFit:'shrinkText',
    wrap:'square',
    lineSpacing:numberOr(style.lineHeight, 1.3),
    insets:{ left:0, right:0, top:0, bottom:0 },
  };
}

function addShape(slide, element, theme) {
  slide.shapes.add({
    geometry:element.elementType === 'line' ? 'line' : String(element.shapeName || 'rect'),
    name:safeName(element.elementId),
    position:position(element.bounds),
    fill:element.elementType === 'line' ? 'none' : resolveFill(element.fill, theme),
    line:resolveLine(element.line || element.border, theme),
  });
}

async function addImage(slide, element, theme, projectRoot) {
  const mediaPath = await safeProjectFile(projectRoot, element.src);
  const extension = path.extname(mediaPath).toLowerCase();
  const contentType = ALLOWED_MEDIA_EXTENSIONS.get(extension);
  if (!contentType) throw controlledError('图片格式不受支持。', 'pptd_media_unsupported');
  const bytes = await fs.readFile(mediaPath);
  slide.images.add({
    blob:bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    contentType,
    alt:safeName(element.elementId),
    fit:element.fit?.mode === 'cover' ? 'cover' : 'contain',
    position:position(element.bounds),
  });
  const border = resolveLine(element.border, theme);
  if (border.width > 0) {
    slide.shapes.add({
      geometry:'rect',
      name:`${safeName(element.elementId)}-border`,
      position:position(element.bounds),
      fill:'none',
      line:border,
    });
  }
}

function addTable(slide, element, theme) {
  const values = element.rows.map((row) => row.map((cell) => String(cell?.text ?? cell ?? '')));
  const table = slide.tables.add({
    rows:values.length,
    columns:values[0].length,
    left:element.bounds[0],
    top:element.bounds[1],
    width:element.bounds[2],
    height:element.bounds[3],
    values,
  });
  const styleName = String(element.style || '$default').replace(/^\$/, '');
  const style = theme?.tableStyles?.[styleName] || theme?.tableStyles?.default || {};
  const cellStyle = style.cellStyle || {};
  table.borders.assign(resolveLine(cellStyle.border, theme));
  for (let row = 0; row < values.length; row += 1) {
    for (let column = 0; column < values[row].length; column += 1) {
      const cell = table.getCell(row, column);
      const rowStyle = row === 0 ? style.firstRowStyle || {} : style.bodyStyles?.[(row - 1) % Math.max(1, style.bodyStyles?.length || 1)] || {};
      cell.fill = resolveFill(rowStyle.fill || cellStyle.fill, theme);
      cell.text.style = {
        fontSize:numberOr(rowStyle.fontSize, numberOr(cellStyle.fontSize, 14)),
        typeface:OFFICE_CJK_FONT,
        bold:rowStyle.bold === true,
        color:resolveColor(rowStyle.color || cellStyle.color || '#1F2937', theme),
        alignment:horizontalAlignment(cellStyle.align?.[0] || 'center'),
        verticalAlignment:verticalAlignment(cellStyle.align?.[1] || 'middle'),
        autoFit:'shrinkText',
      };
    }
  }
}

function addChart(slide, element, theme) {
  const categories = element.data.rows.map((row) => String(row[0]));
  const values = element.data.rows.map((row) => Number(row[1]));
  slide.charts.add('bar', {
    position:position(element.bounds),
    title:String(element.title || ''),
    titlePlacement:element.title ? 'aboveChart' : 'none',
    titleTextStyle:{ fontSize:16, bold:true, fill:resolveColor('$navy', theme) },
    categories,
    series:[{ name:String(element.title || '数据'), values, fill:resolveColor(element.series?.[0]?.fill || '$primary', theme) }],
    hasLegend:element.legend === true,
    barOptions:{ direction:'column', grouping:'clustered', varyColors:false },
    dataLabels:{ showValue:element.series?.[0]?.dataLabels?.show === true, position:'outEnd', textStyle:{ fontSize:12 } },
    xAxis:{ textStyle:{ fontSize:12 } },
    yAxis:{ textStyle:{ fontSize:11 }, majorGridlines:{ style:'solid', fill:resolveColor('$line', theme), width:1 } },
    chartFill:'#FFFFFF',
    chartLine:{ style:'solid', fill:resolveColor('$line', theme), width:1 },
    plotAreaFill:'#FFFFFF',
  });
}

async function exportSlideEvidence(presentation, previewDirectory, layoutDirectory) {
  for (const [index, slide] of presentation.slides.items.entries()) {
    const number = String(index + 1).padStart(2, '0');
    const preview = await presentation.export({ slide, format:'png', scale:2 });
    await writeBlob(path.join(previewDirectory, `slide-${number}.png`), preview);
    const layout = await slide.export({ format:'layout' });
    await fs.writeFile(path.join(layoutDirectory, `slide-${number}.json`), await layout.text(), { flag:'wx', mode:0o600 });
  }
}

async function exportRenderedEvidence(presentation, renderedDirectory, qaDirectory, sharp) {
  const renderedPaths = [];
  for (const [index, slide] of presentation.slides.items.entries()) {
    const number = String(index + 1).padStart(2, '0');
    const preview = await presentation.export({ slide, format:'png', scale:2 });
    const target = path.join(renderedDirectory, `slide-${number}.png`);
    await writeBlob(target, preview);
    renderedPaths.push(target);
  }
  const columns = Math.min(2, renderedPaths.length);
  const rows = Math.ceil(renderedPaths.length / columns);
  const thumbWidth = 720;
  const thumbHeight = 405;
  const gap = 20;
  const composites = [];
  for (const [index, renderedPath] of renderedPaths.entries()) {
    const input = await sharp(renderedPath).resize(thumbWidth, thumbHeight, { fit:'fill' }).png().toBuffer();
    composites.push({
      input,
      left:(index % columns) * (thumbWidth + gap),
      top:Math.floor(index / columns) * (thumbHeight + gap),
    });
  }
  await sharp({
    create:{
      width:columns * thumbWidth + (columns - 1) * gap,
      height:rows * thumbHeight + (rows - 1) * gap,
      channels:3,
      background:'#E2E8F0',
    },
  }).composite(composites).jpeg({ quality:90 }).toFile(path.join(qaDirectory, 'overview.jpg'));
}

async function patchAndValidatePptx(bytes, JSZip, expectedSlides) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32:true });
  const slideNames = slideEntryNames(zip);
  if (slideNames.length !== expectedSlides) throw controlledError('PPTX 页数不一致。', 'pptx_page_count_mismatch');
  const xmlNames = Object.keys(zip.files).filter((name) => /^ppt\/.*\.xml$/.test(name) && !zip.files[name].dir);
  for (const xmlName of xmlNames) {
    const xml = await zip.file(xmlName).async('string');
    zip.file(xmlName, patchFontCompatibility(xml));
  }
  for (const slideName of slideNames) {
    const xml = await zip.file(slideName).async('string');
    zip.file(slideName, patchFadeTransition(xml));
  }
  const patched = await zip.generateAsync({ type:'nodebuffer', compression:'DEFLATE', compressionOptions:{ level:6 } });
  await validatePptx(patched, JSZip, expectedSlides);
  return patched;
}

function patchFontCompatibility(xml) {
  const fontRun = `<a:latin typeface="${OFFICE_CJK_FONT}" /><a:ea typeface="${OFFICE_CJK_FONT}" /><a:cs typeface="${OFFICE_CJK_FONT}" />`;
  let patched = xml.replace(
    /<a:(latin|ea|cs)\b[^>]*\/>/g,
    (_match, elementName) => `<a:${elementName} typeface="${OFFICE_CJK_FONT}" />`,
  );
  for (const elementName of ['defRPr', 'rPr', 'endParaRPr']) {
    const selfClosing = new RegExp(`<a:${elementName}([^>]*)\\/>`, 'g');
    patched = patched.replace(selfClosing, `<a:${elementName}$1>${fontRun}</a:${elementName}>`);
    const paired = new RegExp(`<a:${elementName}([^>]*)>([\\s\\S]*?)<\\/a:${elementName}>`, 'g');
    patched = patched.replace(paired, (match, attributes, body) => {
      if (/<a:latin\b/.test(body) && /<a:ea\b/.test(body) && /<a:cs\b/.test(body)) return match;
      const withoutIncompleteTypeface = body.replace(/<a:(latin|ea|cs)\b[^>]*\/>/g, '');
      return `<a:${elementName}${attributes}>${withoutIncompleteTypeface}${fontRun}</a:${elementName}>`;
    });
  }
  return patched;
}

function patchFadeTransition(xml) {
  const cSldEnd = xml.indexOf('</p:cSld>');
  if (cSldEnd < 0) throw controlledError('PPTX 页面缺少 cSld。', 'pptx_slide_xml_invalid');
  const prefixEnd = cSldEnd + '</p:cSld>'.length;
  const prefix = xml.slice(0, prefixEnd);
  let tail = xml.slice(prefixEnd);
  tail = tail.replace(/<p:transition\b[^>]*\/>/g, '').replace(/<p:transition\b[^>]*>[\s\S]*?<\/p:transition>/g, '');
  const insertionCandidates = ['<p:timing', '<p:extLst', '</p:sld>']
    .map((token) => tail.indexOf(token))
    .filter((index) => index >= 0);
  if (!insertionCandidates.length) throw controlledError('PPTX 页面 XML 顺序不可识别。', 'pptx_slide_xml_invalid');
  const insertion = Math.min(...insertionCandidates);
  const transition = '<p:transition spd="slow" advClick="1"><p:fade/></p:transition>';
  return `${prefix}${tail.slice(0, insertion)}${transition}${tail.slice(insertion)}`;
}

async function validatePptx(bytes, JSZip, expectedSlides) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32:true });
  const slideNames = slideEntryNames(zip);
  if (slideNames.length !== expectedSlides) throw controlledError('PPTX 页数校验失败。', 'pptx_page_count_mismatch');
  let fadeTransitions = 0;
  const referencedFonts = new Set();
  for (const slideName of slideNames) {
    const xml = await zip.file(slideName).async('string');
    const cSldEnd = xml.indexOf('</p:cSld>');
    const transitionIndex = xml.indexOf('<p:transition', cSldEnd);
    const fadeIndex = xml.indexOf('<p:fade', transitionIndex);
    const timingIndex = xml.indexOf('<p:timing', cSldEnd);
    const extLstIndex = xml.indexOf('<p:extLst', cSldEnd);
    const slideEnd = xml.lastIndexOf('</p:sld>');
    const rootTail = cSldEnd >= 0 ? xml.slice(cSldEnd) : '';
    if ((rootTail.match(/<p:transition\b/g) || []).length !== 1 || transitionIndex < cSldEnd || fadeIndex < transitionIndex) {
      throw controlledError('PPTX 每页必须有且只有一个根级 fade 转场。', 'pptx_transition_invalid');
    }
    const next = [timingIndex, extLstIndex, slideEnd].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    if (transitionIndex >= next) throw controlledError('PPTX 转场 XML 顺序无效。', 'pptx_transition_order_invalid');
    fadeTransitions += 1;
  }
  const presentationXmlNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/.*\.xml$/.test(name) && !zip.files[name].dir);
  for (const xmlName of presentationXmlNames) {
    const xml = await zip.file(xmlName).async('string');
    for (const match of xml.matchAll(/<a:(?:latin|ea|cs)\b[^>]*typeface="([^"]+)"/g)) referencedFonts.add(match[1]);
  }
  const fontCompatibilityVerified = referencedFonts.size === 1 && referencedFonts.has(OFFICE_CJK_FONT);
  if (!fontCompatibilityVerified) {
    throw controlledError('PPTX 字体兼容策略校验失败。', 'pptx_font_compatibility_invalid');
  }
  const fontParts = Object.keys(zip.files).filter((name) => /^ppt\/fonts\//.test(name) && !zip.files[name].dir).length;
  return {
    zipIntegrityValid:true,
    fadeTransitions,
    transitionXmlOrderValid:true,
    fontParts,
    referencedFonts:[...referencedFonts].sort(),
    fontCompatibilityVerified,
  };
}

async function readProjectPages(projectRoot, manifest) {
  if (manifest?.version !== 'v2' || !Array.isArray(manifest.size) || manifest.size.length !== 2) {
    throw controlledError('PPTD 版本或页面尺寸无效。', 'pptd_manifest_invalid');
  }
  if (!manifest.size.every((value) => Number.isFinite(value) && value > 0) || !Array.isArray(manifest.pages) || !manifest.pages.length) {
    throw controlledError('PPTD 页面声明无效。', 'pptd_manifest_invalid');
  }
  const pages = [];
  for (const relativePath of manifest.pages) {
    if (!/^pages\/[A-Za-z0-9][A-Za-z0-9._-]*\.page$/.test(String(relativePath || ''))) {
      throw controlledError('PPTD 页面路径越界。', 'pptd_page_path_denied');
    }
    const pagePath = await safeProjectFile(projectRoot, relativePath);
    const page = await readJsonFile(pagePath, 4 * 1024 * 1024);
    if (!Array.isArray(page.elements) || !page.elements.length) throw controlledError('PPTD 页面没有元素。', 'pptd_page_invalid');
    for (const element of page.elements) {
      if (!validBounds(element.bounds, manifest.size)) throw controlledError('PPTD 元素越出页面。', 'pptd_bounds_invalid');
    }
    pages.push(page);
  }
  return pages;
}

async function safeProjectFile(projectRoot, relativePath) {
  const relative = String(relativePath || '').replaceAll('\\', '/');
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw controlledError('PPTD 引用必须是项目内安全相对路径。', 'pptd_reference_denied');
  }
  const root = await fs.realpath(projectRoot);
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw controlledError('PPTD 引用越出项目。', 'pptd_reference_denied');
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw controlledError('PPTD 引用不是普通文件。', 'pptd_reference_denied');
  const real = await fs.realpath(target);
  if (!real.startsWith(`${root}${path.sep}`)) throw controlledError('PPTD 引用越出项目。', 'pptd_reference_denied');
  return real;
}

function resolveTextStyle(value, theme) {
  const key = String(value || '').replace(/^\$/, '');
  return theme?.textStyles?.[key] || {};
}

function resolveColor(value, theme) {
  const text = String(value || '#000000');
  if (text.startsWith('$')) return String(theme?.colors?.[text.slice(1)] || '#000000');
  return text;
}

function resolveFill(value, theme) {
  if (!value || value === 'none') return 'none';
  if (typeof value === 'string') return resolveColor(value, theme);
  if (value.type === 'solid') return resolveColor(value.color || '#FFFFFF', theme);
  return 'none';
}

function resolveLine(value, theme) {
  if (!value || value === 'none') return { style:'solid', fill:'none', width:0 };
  return {
    style:['solid', 'dashed', 'dotted', 'dash-dot', 'dash-dot-dot'].includes(value.style) ? value.style : 'solid',
    fill:resolveColor(value.color || value.fill || '#000000', theme),
    width:numberOr(value.width, 1),
  };
}

function richTextParagraphs(value) {
  const text = String(value ?? '');
  if (!/<p\b/i.test(text)) return [decodeEntities(text.replace(/<[^>]+>/g, ''))];
  return [...text.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => {
    const cleaned = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
    if (cleaned.startsWith('• ')) {
      return { bulletCharacter:'•', marginLeft:20, indent:-12, spaceAfter:8, runs:[cleaned.slice(2)] };
    }
    return { runs:[cleaned], spaceAfter:8 };
  });
}

function decodeEntities(value) {
  return String(value).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

function position(bounds) {
  return { left:bounds[0], top:bounds[1], width:bounds[2], height:bounds[3] };
}

function validBounds(value, size) {
  return Array.isArray(value) && value.length === 4
    && value.every((item) => Number.isFinite(item) && item >= 0)
    && value[2] > 0 && value[3] > 0
    && value[0] + value[2] <= size[0]
    && value[1] + value[3] <= size[1];
}

function horizontalAlignment(value) {
  return ['left', 'center', 'right', 'justify'].includes(value) ? value : 'left';
}

function verticalAlignment(value) {
  return ['top', 'middle', 'bottom'].includes(value) ? value : 'top';
}

function safeName(value) {
  return String(value || 'element').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'element';
}

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function slideEntryNames(zip) {
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)/)[1]) - Number(right.match(/slide(\d+)/)[1]));
}

async function writeBlob(target, blob) {
  await fs.writeFile(target, Buffer.from(await blob.arrayBuffer()), { flag:'wx', mode:0o600 });
}

async function readJsonFile(filePath, maxBytes) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
    throw controlledError('演示文稿输入文件无效。', 'presentation_source_invalid');
  }
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw controlledError('演示文稿输入不是受控 JSON 兼容 PPTD。', 'presentation_source_invalid');
  }
}

async function assertMissing(target) {
  if (await fs.lstat(target).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) {
    throw controlledError('目标已存在，禁止覆盖。', 'workspace_file_exists');
  }
}

async function listRegularFiles(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes:true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listRegularFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value == null) throw controlledError('本地 PPTX 导出参数无效。', 'local_pptx_args_invalid');
    result[name.slice(2)] = value;
  }
  return result;
}

function requiredArg(args, name) {
  const value = String(args[name] || '').trim();
  if (!value) throw controlledError(`缺少 --${name}。`, 'local_pptx_args_invalid');
  return value;
}

function controlledError(message, code) {
  return Object.assign(new Error(message), { code });
}

main().catch((error) => {
  const code = /^[a-z0-9_]{1,80}$/i.test(String(error?.code || '')) ? error.code : 'local_pptx_export_failed';
  const diagnostic = process.env.AGENT_ARMY_LOCAL_PPTX_DEBUG === '1'
    ? { code, message:String(error?.message || error).slice(0, 500), stack:String(error?.stack || '').slice(0, 2000) }
    : { code };
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 1;
});
