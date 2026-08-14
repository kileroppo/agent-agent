#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ALLOWED_ELEMENT_TYPES: any = new Set(['text', 'shape', 'line', 'image', 'table', 'chart']);
const OFFICE_CJK_FONT: any = 'Arial Unicode MS';
const ALLOWED_MEDIA_EXTENSIONS: any = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.svg', 'image/svg+xml'],
]);
async function main(): Promise<any> {
    const args: any = parseArgs(process.argv.slice(2));
    const manifestPath: any = path.resolve(requiredArg(args, 'manifest'));
    const outputPath: any = path.resolve(requiredArg(args, 'output'));
    const qaDirectory: any = path.resolve(requiredArg(args, 'qa-dir'));
    const artifactEntry: any = path.resolve(requiredArg(args, 'artifact-entry'));
    const jszipEntry: any = path.resolve(requiredArg(args, 'jszip-entry'));
    const sharpEntry: any = path.resolve(requiredArg(args, 'sharp-entry'));
    await assertMissing(outputPath);
    await assertMissing(qaDirectory);
    const projectRoot: any = path.dirname(manifestPath);
    const manifest: any = await readJsonFile(manifestPath, 1024 * 1024);
    const pages: any = await readProjectPages(projectRoot, manifest);
    const { Presentation, PresentationFile, FileBlob } = await import(pathToFileURL(artifactEntry).href);
    const jszipModule: any = await import(pathToFileURL(jszipEntry).href);
    const JSZip: any = jszipModule.default || jszipModule;
    const sharpModule: any = await import(pathToFileURL(sharpEntry).href);
    const sharp: any = sharpModule.default || sharpModule;
    const presentation: any = Presentation.create({
        slideSize: { width: manifest.size[0], height: manifest.size[1] },
    });
    for (const [index, page] of pages.entries()) {
        const slide: any = presentation.slides.add();
        await addPage({ presentation, slide, page, manifest, projectRoot, pageNumber: index + 1 });
    }
    const sourcePreviewDirectory: any = path.join(qaDirectory, 'source-pages');
    const renderedPreviewDirectory: any = path.join(qaDirectory, 'pages');
    const layoutDirectory: any = path.join(qaDirectory, 'layouts');
    await Promise.all([
        fs.mkdir(sourcePreviewDirectory, { recursive: true, mode: 0o700 }),
        fs.mkdir(renderedPreviewDirectory, { recursive: true, mode: 0o700 }),
        fs.mkdir(layoutDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await exportSlideEvidence(presentation, sourcePreviewDirectory, layoutDirectory);
    const exported: any = await PresentationFile.exportPptx(presentation);
    const stagingDirectory: any = await fs.mkdtemp(path.join(path.dirname(outputPath), '.local-pptx-export-'));
    let patchedBytes: any;
    try {
        const stagingPath: any = path.join(stagingDirectory, 'unpatched.pptx');
        await exported.save(stagingPath);
        patchedBytes = await patchAndValidatePptx(await fs.readFile(stagingPath), JSZip, pages.length);
        await fs.writeFile(outputPath, patchedBytes, { flag: 'wx', mode: 0o600 });
    }
    finally {
        await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
    const imported: any = await PresentationFile.importPptx(await FileBlob.load(outputPath));
    if (imported.slides.items.length !== pages.length) {
        throw controlledError('PPTX 回读页数与 PPTD 不一致。', 'pptx_roundtrip_page_count_mismatch');
    }
    await exportRenderedEvidence(imported, renderedPreviewDirectory, qaDirectory, sharp);
    const zipValidation: any = await validatePptx(await fs.readFile(outputPath), JSZip, pages.length);
    const qaFiles: any = await listRegularFiles(qaDirectory);
    const summary: Record<string, any> = {
        schemaVersion: 'agent.army/local-pptx-export/v1',
        status: 'passed',
        slides: pages.length,
        fadeTransitions: zipValidation.fadeTransitions,
        transitionPatchedSlides: zipValidation.fadeTransitions,
        transitionXmlOrderValid: zipValidation.transitionXmlOrderValid,
        zipIntegrityValid: zipValidation.zipIntegrityValid,
        fontParts: zipValidation.fontParts,
        referencedFonts: zipValidation.referencedFonts,
        fontEmbeddingVerified: zipValidation.fontParts > 0,
        fontCompatibilityTypeface: OFFICE_CJK_FONT,
        fontCompatibilityVerified: zipValidation.fontCompatibilityVerified,
        renderedSlides: imported.slides.items.length,
        qaFileCount: qaFiles.length,
        bytes: patchedBytes.length,
        checksum: crypto.createHash('sha256').update(patchedBytes).digest('hex'),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
}
async function addPage({ slide, page, manifest, projectRoot, pageNumber }: any): Promise<any> {
    slide.background.fill = resolveColor(page.background?.color || '#FFFFFF', manifest.theme);
    for (const element of page.elements) {
        if (!ALLOWED_ELEMENT_TYPES.has(element.elementType)) {
            throw controlledError(`第 ${pageNumber} 页包含不支持的元素。`, 'pptd_element_unsupported');
        }
        if (element.elementType === 'text')
            addText(slide, element, manifest.theme);
        if (element.elementType === 'shape' || element.elementType === 'line')
            addShape(slide, element, manifest.theme);
        if (element.elementType === 'image')
            await addImage(slide, element, manifest.theme, projectRoot);
        if (element.elementType === 'table')
            addTable(slide, element, manifest.theme);
        if (element.elementType === 'chart')
            addChart(slide, element, manifest.theme);
    }
    const sources: any = page.elements
        .filter((element: any): any => element.elementType === 'image')
        .map((element: any): any => `- Local workspace asset: ${element.src}`);
    const noteText: any = [page.notes ? String(page.notes).trim() : '', sources.length ? `[Sources]\n${sources.join('\n')}` : '']
        .filter(Boolean)
        .join('\n\n');
    if (noteText)
        slide.speakerNotes.textFrame.setText(noteText);
}
function addText(slide: any, element: any, theme: any): any {
    const style: any = resolveTextStyle(element.content?.style, theme);
    const shape: any = slide.shapes.add({
        geometry: 'textbox',
        name: safeName(element.elementId),
        position: position(element.bounds),
        fill: 'none',
        line: { style: 'solid', fill: 'none', width: 0 },
    });
    const paragraphs: any = richTextParagraphs(element.content?.text);
    shape.text = paragraphs.length > 1 || paragraphs.some((item: any): any => typeof item === 'object')
        ? paragraphs
        : String(paragraphs[0] || '');
    shape.text.style = {
        fontSize: numberOr(style.fontSize, 18),
        typeface: String(style.fontFamily || style.typeface || OFFICE_CJK_FONT),
        bold: style.bold === true,
        color: resolveColor(style.color || '#1F2937', theme),
        alignment: horizontalAlignment(element.content?.align?.[0]),
        verticalAlignment: verticalAlignment(element.content?.align?.[1]),
        autoFit: 'shrinkText',
        wrap: 'square',
        lineSpacing: numberOr(style.lineHeight, 1.3),
        insets: { left: 0, right: 0, top: 0, bottom: 0 },
    };
}
function addShape(slide: any, element: any, theme: any): any {
    slide.shapes.add({
        geometry: element.elementType === 'line' ? 'line' : String(element.shapeName || 'rect'),
        name: safeName(element.elementId),
        position: position(element.bounds),
        fill: element.elementType === 'line' ? 'none' : resolveFill(element.fill, theme),
        line: resolveLine(element.line || element.border, theme),
    });
}
async function addImage(slide: any, element: any, theme: any, projectRoot: any): Promise<any> {
    const mediaPath: any = await safeProjectFile(projectRoot, element.src);
    const extension: any = path.extname(mediaPath).toLowerCase();
    const contentType: any = ALLOWED_MEDIA_EXTENSIONS.get(extension);
    if (!contentType)
        throw controlledError('图片格式不受支持。', 'pptd_media_unsupported');
    const bytes: any = await fs.readFile(mediaPath);
    slide.images.add({
        blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        contentType,
        alt: safeName(element.elementId),
        fit: element.fit?.mode === 'cover' ? 'cover' : 'contain',
        position: position(element.bounds),
    });
    const border: any = resolveLine(element.border, theme);
    if (border.width > 0) {
        slide.shapes.add({
            geometry: 'rect',
            name: `${safeName(element.elementId)}-border`,
            position: position(element.bounds),
            fill: 'none',
            line: border,
        });
    }
}
function addTable(slide: any, element: any, theme: any): any {
    const values: any = element.rows.map((row: any): any => row.map((cell: any): any => String(cell?.text ?? cell ?? '')));
    const table: any = slide.tables.add({
        rows: values.length,
        columns: values[0].length,
        left: element.bounds[0],
        top: element.bounds[1],
        width: element.bounds[2],
        height: element.bounds[3],
        values,
    });
    const styleName: any = String(element.style || '$default').replace(/^\$/, '');
    const style: any = theme?.tableStyles?.[styleName] || theme?.tableStyles?.default || {};
    const cellStyle: any = style.cellStyle || {};
    table.borders.assign(resolveLine(cellStyle.border, theme));
    for (let row: any = 0; row < values.length; row += 1) {
        for (let column: any = 0; column < values[row].length; column += 1) {
            const cell: any = table.getCell(row, column);
            const rowStyle: any = row === 0 ? style.firstRowStyle || {} : style.bodyStyles?.[(row - 1) % Math.max(1, style.bodyStyles?.length || 1)] || {};
            cell.fill = resolveFill(rowStyle.fill || cellStyle.fill, theme);
            cell.text.style = {
                fontSize: numberOr(rowStyle.fontSize, numberOr(cellStyle.fontSize, 14)),
                typeface: OFFICE_CJK_FONT,
                bold: rowStyle.bold === true,
                color: resolveColor(rowStyle.color || cellStyle.color || '#1F2937', theme),
                alignment: horizontalAlignment(cellStyle.align?.[0] || 'center'),
                verticalAlignment: verticalAlignment(cellStyle.align?.[1] || 'middle'),
                autoFit: 'shrinkText',
            };
        }
    }
}
function addChart(slide: any, element: any, theme: any): any {
    const categories: any = element.data.rows.map((row: any): any => String(row[0]));
    const values: any = element.data.rows.map((row: any): any => Number(row[1]));
    slide.charts.add('bar', {
        position: position(element.bounds),
        title: String(element.title || ''),
        titlePlacement: element.title ? 'aboveChart' : 'none',
        titleTextStyle: { fontSize: 16, bold: true, fill: resolveColor('$navy', theme) },
        categories,
        series: [{ name: String(element.title || '数据'), values, fill: resolveColor(element.series?.[0]?.fill || '$primary', theme) }],
        hasLegend: element.legend === true,
        barOptions: { direction: 'column', grouping: 'clustered', varyColors: false },
        dataLabels: { showValue: element.series?.[0]?.dataLabels?.show === true, position: 'outEnd', textStyle: { fontSize: 12 } },
        xAxis: { textStyle: { fontSize: 12 } },
        yAxis: { textStyle: { fontSize: 11 }, majorGridlines: { style: 'solid', fill: resolveColor('$line', theme), width: 1 } },
        chartFill: '#FFFFFF',
        chartLine: { style: 'solid', fill: resolveColor('$line', theme), width: 1 },
        plotAreaFill: '#FFFFFF',
    });
}
async function exportSlideEvidence(presentation: any, previewDirectory: any, layoutDirectory: any): Promise<any> {
    for (const [index, slide] of presentation.slides.items.entries()) {
        const number: any = String(index + 1).padStart(2, '0');
        const preview: any = await presentation.export({ slide, format: 'png', scale: 2 });
        await writeBlob(path.join(previewDirectory, `slide-${number}.png`), preview);
        const layout: any = await slide.export({ format: 'layout' });
        await fs.writeFile(path.join(layoutDirectory, `slide-${number}.json`), await layout.text(), { flag: 'wx', mode: 0o600 });
    }
}
async function exportRenderedEvidence(presentation: any, renderedDirectory: any, qaDirectory: any, sharp: any): Promise<any> {
    const renderedPaths: any[] = [];
    for (const [index, slide] of presentation.slides.items.entries()) {
        const number: any = String(index + 1).padStart(2, '0');
        const preview: any = await presentation.export({ slide, format: 'png', scale: 2 });
        const target: any = path.join(renderedDirectory, `slide-${number}.png`);
        await writeBlob(target, preview);
        renderedPaths.push(target);
    }
    const columns: any = Math.min(2, renderedPaths.length);
    const rows: any = Math.ceil(renderedPaths.length / columns);
    const thumbWidth: any = 720;
    const thumbHeight: any = 405;
    const gap: any = 20;
    const composites: any[] = [];
    for (const [index, renderedPath] of renderedPaths.entries()) {
        const input: any = await sharp(renderedPath).resize(thumbWidth, thumbHeight, { fit: 'fill' }).png().toBuffer();
        composites.push({
            input,
            left: (index % columns) * (thumbWidth + gap),
            top: Math.floor(index / columns) * (thumbHeight + gap),
        });
    }
    await sharp({
        create: {
            width: columns * thumbWidth + (columns - 1) * gap,
            height: rows * thumbHeight + (rows - 1) * gap,
            channels: 3,
            background: '#E2E8F0',
        },
    }).composite(composites).jpeg({ quality: 90 }).toFile(path.join(qaDirectory, 'overview.jpg'));
}
async function patchAndValidatePptx(bytes: any, JSZip: any, expectedSlides: any): Promise<any> {
    const zip: any = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const slideNames: any = slideEntryNames(zip);
    if (slideNames.length !== expectedSlides)
        throw controlledError('PPTX 页数不一致。', 'pptx_page_count_mismatch');
    const xmlNames: any = Object.keys(zip.files).filter((name: any): any => /^ppt\/.*\.xml$/.test(name) && !zip.files[name].dir);
    for (const xmlName of xmlNames) {
        const xml: any = await zip.file(xmlName).async('string');
        zip.file(xmlName, patchFontCompatibility(xml));
    }
    for (const slideName of slideNames) {
        const xml: any = await zip.file(slideName).async('string');
        zip.file(slideName, patchFadeTransition(xml));
    }
    const patched: any = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await validatePptx(patched, JSZip, expectedSlides);
    return patched;
}
function patchFontCompatibility(xml: any): any {
    const fontRun: any = `<a:latin typeface="${OFFICE_CJK_FONT}" /><a:ea typeface="${OFFICE_CJK_FONT}" /><a:cs typeface="${OFFICE_CJK_FONT}" />`;
    let patched: any = xml.replace(/<a:(latin|ea|cs)\b[^>]*\/>/g, (_match: any, elementName: any): any => `<a:${elementName} typeface="${OFFICE_CJK_FONT}" />`);
    for (const elementName of ['defRPr', 'rPr', 'endParaRPr']) {
        const selfClosing: any = new RegExp(`<a:${elementName}([^>]*)\\/>`, 'g');
        patched = patched.replace(selfClosing, `<a:${elementName}$1>${fontRun}</a:${elementName}>`);
        const paired: any = new RegExp(`<a:${elementName}([^>]*)>([\\s\\S]*?)<\\/a:${elementName}>`, 'g');
        patched = patched.replace(paired, (match: any, attributes: any, body: any): any => {
            if (/<a:latin\b/.test(body) && /<a:ea\b/.test(body) && /<a:cs\b/.test(body))
                return match;
            const withoutIncompleteTypeface: any = body.replace(/<a:(latin|ea|cs)\b[^>]*\/>/g, '');
            return `<a:${elementName}${attributes}>${withoutIncompleteTypeface}${fontRun}</a:${elementName}>`;
        });
    }
    return patched;
}
function patchFadeTransition(xml: any): any {
    const cSldEnd: any = xml.indexOf('</p:cSld>');
    if (cSldEnd < 0)
        throw controlledError('PPTX 页面缺少 cSld。', 'pptx_slide_xml_invalid');
    const prefixEnd: any = cSldEnd + '</p:cSld>'.length;
    const prefix: any = xml.slice(0, prefixEnd);
    let tail: any = xml.slice(prefixEnd);
    tail = tail.replace(/<p:transition\b[^>]*\/>/g, '').replace(/<p:transition\b[^>]*>[\s\S]*?<\/p:transition>/g, '');
    const insertionCandidates: any = ['<p:timing', '<p:extLst', '</p:sld>']
        .map((token: any): any => tail.indexOf(token))
        .filter((index: any): any => index >= 0);
    if (!insertionCandidates.length)
        throw controlledError('PPTX 页面 XML 顺序不可识别。', 'pptx_slide_xml_invalid');
    const insertion: any = Math.min(...insertionCandidates);
    const transition: any = '<p:transition spd="slow" advClick="1"><p:fade/></p:transition>';
    return `${prefix}${tail.slice(0, insertion)}${transition}${tail.slice(insertion)}`;
}
async function validatePptx(bytes: any, JSZip: any, expectedSlides: any): Promise<any> {
    const zip: any = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const slideNames: any = slideEntryNames(zip);
    if (slideNames.length !== expectedSlides)
        throw controlledError('PPTX 页数校验失败。', 'pptx_page_count_mismatch');
    let fadeTransitions: any = 0;
    const referencedFonts: any = new Set();
    for (const slideName of slideNames) {
        const xml: any = await zip.file(slideName).async('string');
        const cSldEnd: any = xml.indexOf('</p:cSld>');
        const transitionIndex: any = xml.indexOf('<p:transition', cSldEnd);
        const fadeIndex: any = xml.indexOf('<p:fade', transitionIndex);
        const timingIndex: any = xml.indexOf('<p:timing', cSldEnd);
        const extLstIndex: any = xml.indexOf('<p:extLst', cSldEnd);
        const slideEnd: any = xml.lastIndexOf('</p:sld>');
        const rootTail: any = cSldEnd >= 0 ? xml.slice(cSldEnd) : '';
        if ((rootTail.match(/<p:transition\b/g) || []).length !== 1 || transitionIndex < cSldEnd || fadeIndex < transitionIndex) {
            throw controlledError('PPTX 每页必须有且只有一个根级 fade 转场。', 'pptx_transition_invalid');
        }
        const next: any = [timingIndex, extLstIndex, slideEnd].filter((index: any): any => index >= 0).sort((a: any, b: any): any => a - b)[0];
        if (transitionIndex >= next)
            throw controlledError('PPTX 转场 XML 顺序无效。', 'pptx_transition_order_invalid');
        fadeTransitions += 1;
    }
    const presentationXmlNames: any = Object.keys(zip.files)
        .filter((name: any): any => /^ppt\/.*\.xml$/.test(name) && !zip.files[name].dir);
    for (const xmlName of presentationXmlNames) {
        const xml: any = await zip.file(xmlName).async('string');
        for (const match of xml.matchAll(/<a:(?:latin|ea|cs)\b[^>]*typeface="([^"]+)"/g))
            referencedFonts.add(match[1]);
    }
    const fontCompatibilityVerified: any = referencedFonts.size === 1 && referencedFonts.has(OFFICE_CJK_FONT);
    if (!fontCompatibilityVerified) {
        throw controlledError('PPTX 字体兼容策略校验失败。', 'pptx_font_compatibility_invalid');
    }
    const fontParts: any = Object.keys(zip.files).filter((name: any): any => /^ppt\/fonts\//.test(name) && !zip.files[name].dir).length;
    return {
        zipIntegrityValid: true,
        fadeTransitions,
        transitionXmlOrderValid: true,
        fontParts,
        referencedFonts: [...referencedFonts].sort(),
        fontCompatibilityVerified,
    };
}
async function readProjectPages(projectRoot: any, manifest: any): Promise<any> {
    if (manifest?.version !== 'v2' || !Array.isArray(manifest.size) || manifest.size.length !== 2) {
        throw controlledError('PPTD 版本或页面尺寸无效。', 'pptd_manifest_invalid');
    }
    if (!manifest.size.every((value: any): any => Number.isFinite(value) && value > 0) || !Array.isArray(manifest.pages) || !manifest.pages.length) {
        throw controlledError('PPTD 页面声明无效。', 'pptd_manifest_invalid');
    }
    const pages: any[] = [];
    for (const relativePath of manifest.pages) {
        if (!/^pages\/[A-Za-z0-9][A-Za-z0-9._-]*\.page$/.test(String(relativePath || ''))) {
            throw controlledError('PPTD 页面路径越界。', 'pptd_page_path_denied');
        }
        const pagePath: any = await safeProjectFile(projectRoot, relativePath);
        const page: any = await readJsonFile(pagePath, 4 * 1024 * 1024);
        if (!Array.isArray(page.elements) || !page.elements.length)
            throw controlledError('PPTD 页面没有元素。', 'pptd_page_invalid');
        for (const element of page.elements) {
            if (!validBounds(element.bounds, manifest.size))
                throw controlledError('PPTD 元素越出页面。', 'pptd_bounds_invalid');
        }
        pages.push(page);
    }
    return pages;
}
async function safeProjectFile(projectRoot: any, relativePath: any): Promise<any> {
    const relative: any = String(relativePath || '').replaceAll('\\', '/');
    if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
        throw controlledError('PPTD 引用必须是项目内安全相对路径。', 'pptd_reference_denied');
    }
    const root: any = await fs.realpath(projectRoot);
    const target: any = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`))
        throw controlledError('PPTD 引用越出项目。', 'pptd_reference_denied');
    const stat: any = await fs.lstat(target).catch((): any => null);
    if (!stat?.isFile() || stat.isSymbolicLink())
        throw controlledError('PPTD 引用不是普通文件。', 'pptd_reference_denied');
    const real: any = await fs.realpath(target);
    if (!real.startsWith(`${root}${path.sep}`))
        throw controlledError('PPTD 引用越出项目。', 'pptd_reference_denied');
    return real;
}
function resolveTextStyle(value: any, theme: any): any {
    const key: any = String(value || '').replace(/^\$/, '');
    return theme?.textStyles?.[key] || {};
}
function resolveColor(value: any, theme: any): any {
    const text: any = String(value || '#000000');
    if (text.startsWith('$'))
        return String(theme?.colors?.[text.slice(1)] || '#000000');
    return text;
}
function resolveFill(value: any, theme: any): any {
    if (!value || value === 'none')
        return 'none';
    if (typeof value === 'string')
        return resolveColor(value, theme);
    if (value.type === 'solid')
        return resolveColor(value.color || '#FFFFFF', theme);
    return 'none';
}
function resolveLine(value: any, theme: any): any {
    if (!value || value === 'none')
        return { style: 'solid', fill: 'none', width: 0 };
    return {
        style: ['solid', 'dashed', 'dotted', 'dash-dot', 'dash-dot-dot'].includes(value.style) ? value.style : 'solid',
        fill: resolveColor(value.color || value.fill || '#000000', theme),
        width: numberOr(value.width, 1),
    };
}
function richTextParagraphs(value: any): any {
    const text: any = String(value ?? '');
    if (!/<p\b/i.test(text))
        return [decodeEntities(text.replace(/<[^>]+>/g, ''))];
    return [...text.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match: any): any => {
        const cleaned: any = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
        if (cleaned.startsWith('• ')) {
            return { bulletCharacter: '•', marginLeft: 20, indent: -12, spaceAfter: 8, runs: [cleaned.slice(2)] };
        }
        return { runs: [cleaned], spaceAfter: 8 };
    });
}
function decodeEntities(value: any): any {
    return String(value).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}
function position(bounds: any): any {
    return { left: bounds[0], top: bounds[1], width: bounds[2], height: bounds[3] };
}
function validBounds(value: any, size: any): any {
    return Array.isArray(value) && value.length === 4
        && value.every((item: any): any => Number.isFinite(item) && item >= 0)
        && value[2] > 0 && value[3] > 0
        && value[0] + value[2] <= size[0]
        && value[1] + value[3] <= size[1];
}
function horizontalAlignment(value: any): any {
    return ['left', 'center', 'right', 'justify'].includes(value) ? value : 'left';
}
function verticalAlignment(value: any): any {
    return ['top', 'middle', 'bottom'].includes(value) ? value : 'top';
}
function safeName(value: any): any {
    return String(value || 'element').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'element';
}
function numberOr(value: any, fallback: any): any {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
function slideEntryNames(zip: any): any {
    return Object.keys(zip.files)
        .filter((name: any): any => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((left: any, right: any): any => Number(left.match(/slide(\d+)/)[1]) - Number(right.match(/slide(\d+)/)[1]));
}
async function writeBlob(target: any, blob: any): Promise<any> {
    await fs.writeFile(target, Buffer.from(await blob.arrayBuffer()), { flag: 'wx', mode: 0o600 });
}
async function readJsonFile(filePath: any, maxBytes: any): Promise<any> {
    const stat: any = await fs.lstat(filePath).catch((): any => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
        throw controlledError('演示文稿输入文件无效。', 'presentation_source_invalid');
    }
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch {
        throw controlledError('演示文稿输入不是受控 JSON 兼容 PPTD。', 'presentation_source_invalid');
    }
}
async function assertMissing(target: any): Promise<any> {
    if (await fs.lstat(target).then((): any => true).catch((error: any): any => error?.code === 'ENOENT' ? false : Promise.reject(error))) {
        throw controlledError('目标已存在，禁止覆盖。', 'workspace_file_exists');
    }
}
async function listRegularFiles(root: any): Promise<any> {
    const result: any[] = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const target: any = path.join(root, entry.name);
        if (entry.isDirectory())
            result.push(...await listRegularFiles(target));
        else if (entry.isFile())
            result.push(target);
    }
    return result;
}
function parseArgs(argv: any): any {
    const result: Record<string, any> = {};
    for (let index: any = 0; index < argv.length; index += 2) {
        const name: any = argv[index];
        const value: any = argv[index + 1];
        if (!name?.startsWith('--') || value == null)
            throw controlledError('本地 PPTX 导出参数无效。', 'local_pptx_args_invalid');
        result[name.slice(2)] = value;
    }
    return result;
}
function requiredArg(args: any, name: any): any {
    const value: any = String(args[name] || '').trim();
    if (!value)
        throw controlledError(`缺少 --${name}。`, 'local_pptx_args_invalid');
    return value;
}
function controlledError(message: any, code: any): any {
    return Object.assign(new Error(message), { code });
}
main().catch((error: any): any => {
    const code: any = /^[a-z0-9_]{1,80}$/i.test(String(error?.code || '')) ? error.code : 'local_pptx_export_failed';
    const diagnostic: any = process.env.AGENT_ARMY_LOCAL_PPTX_DEBUG === '1'
        ? { code, message: String(error?.message || error).slice(0, 500), stack: String(error?.stack || '').slice(0, 2000) }
        : { code };
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.exitCode = 1;
});
