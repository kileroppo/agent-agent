#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderM5SocialCardPackage } from '../src/social-card-tools.ts';
import { sha256 } from '../src/policy.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '../../../../..');
const requestedWorkspace = process.argv[2];
if (!requestedWorkspace) {
  throw new Error('用法：node scripts/verify-social-card-render.mjs <全新工作区目录>');
}
const workspace = path.resolve(requestedWorkspace);
if (await fs.lstat(workspace).then(() => true).catch(() => false)) {
  throw new Error(`验收工作区已存在，拒绝覆盖：${workspace}`);
}
await fs.mkdir(path.join(workspace, 'assets'), { recursive:true, mode:0o700 });
const sourceAsset = path.join(repositoryRoot, 'docs/assets/agent-army-project-overview.png');
const assetBytes = await fs.readFile(sourceAsset);
const relativeAsset = 'assets/agent-army-project-overview.png';
await fs.writeFile(path.join(workspace, relativeAsset), assetBytes, { mode:0o600, flag:'wx' });

const templateBindingHash = `sha256:${'a'.repeat(64)}`;
const result = await renderM5SocialCardPackage({
  localFolders:{
    status:async () => ({ healthy:true, writable:true, realPath:workspace }),
  },
}, {
  outputDir:'candidate/social-cards',
  props:{
    platform:'xiaohongshu',
    title:'Agent军团可信交付',
    subtitle:'从任务到可核验产物',
    sourceLabel:'本地候选产物',
    rightsBasis:'仓库自有项目总览图，仅用于本地候选产物验收',
    templateBinding:{ bindingHash:templateBindingHash },
    assetLedger:[{ relativePath:relativeAsset, checksum:sha256(assetBytes) }],
    cards:[
      {
        id:'cover',
        kind:'cover',
        headline:'别把运行当完成',
        body:'真正的交付，要落到路径、哈希和可复核结果。',
        bullets:['任务边界', '真实回执', '人工验收'],
      },
      {
        id:'evidence',
        kind:'evidence',
        headline:'证据进入同一条链',
        body:'素材、模板和输出都绑定到同一个 Case。',
        bullets:['可信素材账本', '固定 1080×1440', '逐文件 SHA-256'],
        imageSrc:relativeAsset,
      },
      {
        id:'checklist',
        kind:'checklist',
        headline:'交付前逐项核对',
        body:'候选产物生成不等于批准、启用或发布。',
        bullets:['代码与测试', '本机真实渲染', '素材与版权血缘', '负责人发布审批'],
      },
    ],
  },
}, {
  companyId:'local-acceptance-company',
}, {
  rendererScript:path.join(scriptDir, 'render-social-card-package.mjs'),
});

process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
