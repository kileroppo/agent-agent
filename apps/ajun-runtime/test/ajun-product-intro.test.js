import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const promptUrl = new URL('../../../agents/ajun/prompts/system.md', import.meta.url);

test('A君产品介绍保持角色定位、三个场景和一个下一步', async () => {
  const prompt = await fs.readFile(promptUrl, 'utf8');
  const section = prompt.match(/## 产品介绍\n([\s\S]*?)\n## /)?.[1] || '';

  assert.match(section, /我是你的军团总管/);
  assert.match(section, /研究：查公开资料或 GitHub/);
  assert.match(section, /内容：处理一条视频，从转录、拆解到一版可拍脚本/);
  assert.match(section, /汇报：把材料或本周工作整理成文档、清单或 PPT/);
  assert.match(section, /直接把主题、链接或材料发给我就行/);
  assert.match(section, /不要调用工具/);
  assert.match(section, /不要罗列岗位、运行状态、技术参数、审批功能或尚未开放的能力/);
});

test('A君状态汇报要求异常先处理再形成上下文闭环', async () => {
  const prompt = await fs.readFile(promptUrl, 'utf8');
  const section = prompt.match(/## 军团状态与异常闭环\n([\s\S]*?)\n## /)?.[1] || '';

  assert.match(section, /军团正常，没有需要你处理的事/);
  assert.match(section, /不要附带员工清单、历史任务数字、能力成熟度、待验证项目/);
  assert.match(section, /先交给运维官诊断/);
  assert.match(section, /最多自动重试一次并复验/);
  assert.match(section, /转技术专家定位根因、形成受控修复范围并验证/);
  assert.match(section, /第一句说明哪项工作出错、正在怎么处理/);
  assert.match(section, /默认最多两句/);
  assert.match(section, /禁止无上下文地插入“小R异常”/);
});
