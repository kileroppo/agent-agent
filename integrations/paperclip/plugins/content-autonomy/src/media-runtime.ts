import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { coded, safeRelativePath, sha256 } from './policy.ts';
const executeFile = promisify(execFile);
async function mediaProbe(ctx: any, params: any, run: any) {
    const { absolute, relative } = await existingWorkspacePath(ctx, run.companyId, params.relativePath);
    const probe = await probeFile(absolute);
    const bytes = await fs.readFile(absolute);
    return {
        content: '音视频规格检查完成。',
        data: { relativePath: relative, checksum: sha256(bytes), probe }
    };
}
async function mediaValidate(ctx: any, params: any, run: any) {
    const { absolute, relative } = await existingWorkspacePath(ctx, run.companyId, params.relativePath);
    const probe = await probeFile(absolute);
    const video = probe.streams.find((item: any) => item.codec_type === 'video');
    const audio = probe.streams.find((item: any) => item.codec_type === 'audio');
    const duration = Number(probe.format?.duration || 0);
    const videoDuration = Number(video?.duration || 0);
    const audioDuration = Number(audio?.duration || 0);
    const errors = [];
    if (video?.codec_name !== 'h264')
        errors.push('视频编码不是 H.264。');
    if (video?.width !== 1080 || video?.height !== 1920)
        errors.push('视频不是 1080×1920 竖屏。');
    if (audio?.codec_name !== 'aac')
        errors.push('音频编码不是 AAC。');
    if (!audio)
        errors.push('缺少音轨。');
    if (videoDuration > 0
        && audioDuration > 0
        && Math.abs(videoDuration - audioDuration) > 0.25) {
        errors.push('音轨与画面时长相差超过 0.25 秒。');
    }
    if (duration < 30 || duration > 60)
        errors.push('成片时长不在 30–60 秒。');
    if (params.expectedDurationSeconds != null && Math.abs(duration - Number(params.expectedDurationSeconds)) > 0.25) {
        errors.push('音画时长与预期相差超过 0.25 秒。');
    }
    const black = await detectBlackFrames(absolute);
    if (black.totalSeconds > 0.1 || black.startsWithBlack || black.endsWithBlack)
        errors.push('检测到不可接受的黑帧。');
    const loudness = await detectLoudness(absolute);
    if (loudness.integratedLufs == null)
        errors.push('无法读取综合响度。');
    else if (loudness.integratedLufs < -18 || loudness.integratedLufs > -12)
        errors.push('综合响度不在 -18 到 -12 LUFS。');
    if (loudness.truePeakDb != null && loudness.truePeakDb > -1)
        errors.push('真实峰值高于 -1 dBTP。');
    return {
        content: errors.length ? '成片机器检查未通过。' : '成片机器检查通过。',
        data: {
            passed: errors.length === 0,
            errors,
            relativePath: relative,
            durationSeconds: duration,
            blackFrames: black,
            loudness,
            specification: {
                width: video?.width,
                height: video?.height,
                videoCodec: video?.codec_name,
                audioCodec: audio?.codec_name,
                videoDurationSeconds: videoDuration || null,
                audioDurationSeconds: audioDuration || null,
            }
        }
    };
}
async function mediaFinalize(ctx: any, params: any, run: any) {
    const input = await existingWorkspacePath(ctx, run.companyId, params.inputPath);
    const output = await writableWorkspacePath(ctx, run.companyId, params.outputPath);
    if (!/\.mp4$/i.test(output.relative))
        throw coded('invalid_media_output', '最终成片必须输出为 .mp4。');
    const temporary = `${output.absolute}.${process.pid}.${crypto.randomUUID()}.tmp.mp4`;
    const args = buildFinalEncodeArgs(input.absolute, temporary);
    try {
        await executeFile('ffmpeg', args, { timeout: 10 * 60000, maxBuffer: 2000000 });
        await replaceFile(temporary, output.absolute);
    }
    catch (error: any) {
        await fs.rm(temporary, { force: true });
        throw coded('ffmpeg_finalize_failed', `最终编码失败：${String(error?.code || 'ffmpeg_error')}。`);
    }
    const bytes = await fs.readFile(output.absolute);
    return {
        content: '最终编码已写入受控内容工作区。',
        data: {
            inputPath: input.relative,
            outputPath: output.relative,
            checksum: sha256(bytes),
            bytes: bytes.length,
            command: { executable: 'ffmpeg', profile: 'm5-vertical-h264-aac-v1' }
        }
    };
}
function buildFinalEncodeArgs(inputPath: any, outputPath: any) {
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', inputPath,
        '-map', '0:v:0', '-map', '0:a:0',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
        '-af', 'loudnorm=I=-15:LRA=7:TP=-1.5',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart', '-shortest',
        outputPath
    ];
}
async function writeArtifactBytes(ctx: any, run: any, relativePath: any, bytes: any) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
        throw coded('artifact_file_empty', '固定产物文件不能为空。');
    }
    const output = await writableWorkspacePath(ctx, run.companyId, relativePath);
    await atomicWriteFile(output.absolute, bytes);
    const readBack = await fs.readFile(output.absolute);
    if (!readBack.equals(bytes))
        throw coded('artifact_write_mismatch', '固定产物写回校验失败。');
    return {
        relativePath: output.relative,
        checksum: sha256(readBack),
        bytes: readBack.length,
    };
}
async function coverPngBytes(sourcePath: any, runFile: any) {
    const source = await fs.readFile(sourcePath);
    if (isPng(source))
        return source;
    const temporary = `${sourcePath}.${process.pid}.${crypto.randomUUID()}.cover.png`;
    try {
        await runFile('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostdin',
            '-y',
            '-i', sourcePath,
            '-frames:v', '1',
            temporary,
        ], { timeout: 60000, maxBuffer: 1000000 });
        const converted = await fs.readFile(temporary);
        if (!isPng(converted))
            throw new Error('invalid_png');
        return converted;
    }
    catch (error: any) {
        throw coded('cover_conversion_failed', `封面转换为 PNG 失败：${String(error?.code || 'ffmpeg_error')}。`);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
}
function isPng(bytes: any) {
    return bytes.length >= 8
        && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
async function probeFile(absolute: any) {
    const { stdout } = await executeFile('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,sample_rate,channels,duration',
        '-of', 'json',
        absolute
    ], { timeout: 30000, maxBuffer: 1000000 });
    return JSON.parse(stdout);
}
async function detectBlackFrames(absolute: any) {
    const { stderr } = await executeFile('ffmpeg', [
        '-hide_banner', '-nostdin', '-i', absolute,
        '-vf', 'blackdetect=d=0.04:pix_th=0.10',
        '-an', '-f', 'null', '-'
    ], { timeout: 120000, maxBuffer: 2000000 });
    return parseBlackDetect(stderr);
}
function parseBlackDetect(stderr: any) {
    const ranges = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
        .map((match: any) => ({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) }));
    const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    const duration = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : 0;
    return {
        ranges,
        totalSeconds: ranges.reduce((sum: any, range: any) => sum + range.duration, 0),
        startsWithBlack: ranges.some((range: any) => range.start <= 0.04),
        endsWithBlack: duration > 0 && ranges.some((range: any) => duration - range.end <= 0.04)
    };
}
async function detectLoudness(absolute: any) {
    const { stderr } = await executeFile('ffmpeg', [
        '-hide_banner', '-nostdin', '-i', absolute,
        '-filter_complex', 'ebur128=peak=true',
        '-f', 'null', '-'
    ], { timeout: 120000, maxBuffer: 2000000 });
    return parseEbur128(stderr);
}
function parseEbur128(stderr: any) {
    const summary = stderr.slice(Math.max(0, stderr.lastIndexOf('Summary:')));
    const integrated = summary.match(/Integrated loudness:\s*I:\s*(-?[\d.]+)\s*LUFS/);
    const truePeak = summary.match(/True peak:\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
    return {
        integratedLufs: integrated ? Number(integrated[1]) : null,
        truePeakDb: truePeak ? Number(truePeak[1]) : null
    };
}
async function workspaceRoot(ctx: any, companyId: any, writable: any = false) {
    const status = await ctx.localFolders.status(companyId, 'content-workspace');
    if (!status.healthy || !status.realPath || (writable && !status.writable)) {
        throw coded('content_workspace_unavailable', writable
            ? '内容生产工作区不可写。'
            : '内容生产工作区尚未配置。');
    }
    return fs.realpath(status.realPath);
}
async function existingWorkspacePath(ctx: any, companyId: any, relativePath: any) {
    const root = await workspaceRoot(ctx, companyId);
    const relative = safeRelativePath(relativePath);
    const absolute = await fs.realpath(path.resolve(root, relative));
    if (!absolute.startsWith(`${root}${path.sep}`))
        throw coded('symlink_escape', '媒体路径逃逸了工作区。');
    return { root, absolute, relative };
}
async function writableWorkspacePath(ctx: any, companyId: any, relativePath: any) {
    const root = await workspaceRoot(ctx, companyId, true);
    const relative = safeRelativePath(relativePath);
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(`${root}${path.sep}`))
        throw coded('path_escape', '输出路径逃逸了工作区。');
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    const realParent = await fs.realpath(path.dirname(candidate));
    if (!realParent.startsWith(`${root}${path.sep}`) && realParent !== root) {
        throw coded('symlink_escape', '输出目录通过符号链接逃逸了工作区。');
    }
    const absolute = path.join(realParent, path.basename(candidate));
    return { root, absolute, relative };
}
async function atomicWriteFile(destination: any, bytes: any) {
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        await replaceFile(temporary, destination);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
}
async function replaceFile(source: any, destination: any) {
    await fs.rename(source, destination);
    await fs.chmod(destination, 0o600);
}
export const mediaRuntime = Object.freeze({
    workspace: Object.freeze({
        existing: existingWorkspacePath,
        writable: writableWorkspacePath,
        writeArtifact: writeArtifactBytes,
    }),
    ffmpeg: Object.freeze({
        probe: mediaProbe,
        validate: mediaValidate,
        finalize: mediaFinalize,
        encodeArgs: buildFinalEncodeArgs,
        parseBlack: parseBlackDetect,
        parseLoudness: parseEbur128,
        coverPng: coverPngBytes,
    }),
});
