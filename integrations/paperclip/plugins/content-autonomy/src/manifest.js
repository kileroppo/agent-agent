const objectSchema = {
  type:'object',
  additionalProperties:false
};

const manifest = {
  id:'agent-army.content-autonomy',
  apiVersion:1,
  version:'0.4.9',
  displayName:'Agent军团·内容自治',
  description:'为 Paperclip/Hermes 补充 StepFun 多模态、受控媒体处理和确定性发布策略，不复制任务、预算、审批或调度控制面。',
  author:'Agent军团',
  categories:['connector', 'automation'],
  // Paperclip 2026.722.0 currently starts its plugin loader without passing
  // the CLI version, so the loader reports the host as 0.0.0 even though
  // /api/health reports 2026.722.0. Keep compatibility pinned by the exact
  // SDK/shared dependencies in package.json until the host-version bug is
  // fixed upstream; declaring the minimum here would reject this verified
  // host before the worker is loaded.
  capabilities:[
    'agent.tools.register',
    'http.outbound',
    'secrets.read-ref',
    'local.folders',
    'plugin.state.read',
    'plugin.state.write',
    'activity.log.write',
    'metrics.write'
  ],
  entrypoints:{ worker:'./src/worker.js' },
  instanceConfigSchema:{
    type:'object',
    properties:{
      stepfunSecretRef:{
        type:'object',
        format:'secret-ref',
        properties:{
          type:{ const:'secret_ref' },
          secretId:{ type:'string', format:'uuid' },
          version:{
            anyOf:[
              { const:'latest' },
              { type:'integer', minimum:1 }
            ]
          }
        },
        required:['type', 'secretId'],
        additionalProperties:false
      },
      stepfunBaseUrl:{ type:'string', format:'uri', default:'https://api.stepfun.com/v1' },
      stepfunMediaBaseUrl:{
        type:'string',
        format:'uri',
        default:'https://api.stepfun.com/step_plan/v1',
        description:'Step Plan 生图、改图和音频接口；与视觉聊天接口分离，避免错误路由。'
      },
      budgetTicketPublicKey:{
        type:'string',
        minLength:80,
        maxLength:1000,
        description:'A君本机预算票据 Ed25519 公钥；插件只验签，不持有私钥。'
      },
      officialTtsVoices:{
        type:'array',
        description:'由负责人根据当前 StepFun 官方文档登记的官方音色白名单。',
        items:{ type:'string', minLength:1 },
        minItems:1,
        uniqueItems:true
      },
      agentToolGrants:{
        type:'object',
        description:'Paperclip agent UUID 到允许工具名数组的显式映射；未登记岗位默认拒绝。',
        additionalProperties:{ type:'array', items:{ type:'string' }, uniqueItems:true }
      },
      agentRoleBindings:{
        type:'object',
        description:'M5 内容岗位到当前 Paperclip Agent UUID 的精确绑定，供插件校验最小 bundle。',
        properties:Object.fromEntries([
          'ajun',
          'intel-researcher',
          'xiaod',
          'video-content-analyst',
          'content-creator',
          'reviewer',
          'operator',
          'office-assistant',
        ].map((role) => [role, { type:'string', format:'uuid' }])),
        required:[
          'ajun',
          'intel-researcher',
          'xiaod',
          'video-content-analyst',
          'content-creator',
          'reviewer',
          'operator',
          'office-assistant',
        ],
        additionalProperties:false
      },
      costRatesCents:{
        type:'object',
        description:'经负责人确认的保守计费率；所有真实调用先生成可被 Paperclip /api/costs 接收的费用事件草稿。',
        properties:{
          visionInputPerMillionTokens:{ type:'number', minimum:0 },
          visionOutputPerMillionTokens:{ type:'number', minimum:0 },
          imagePerGeneration:{ type:'number', minimum:0 },
          ttsPerThousandCharacters:{ type:'number', minimum:0 }
        },
        required:[
          'visionInputPerMillionTokens',
          'visionOutputPerMillionTokens',
          'imagePerGeneration',
          'ttsPerThousandCharacters'
        ],
        additionalProperties:false
      }
    },
    required:[
      'stepfunSecretRef',
      'budgetTicketPublicKey',
      'officialTtsVoices',
      'agentRoleBindings',
      'agentToolGrants',
      'costRatesCents',
    ],
    additionalProperties:false
  },
  localFolders:[{
    folderKey:'content-workspace',
    displayName:'内容生产工作区',
    description:'仅允许读取自产素材并写入生成产物。',
    access:'readWrite'
  }],
  tools:[
    tool('campaign-preflight', '活动授权预检', '校验活动范围、预算、账号引用、上限和禁止动作。', {
      campaign:{ type:'object' }
    }, ['campaign']),
    tool('stepfun-vision', 'StepFun 视觉证据', '读取受控工作区图片并调用 step-1o-turbo-vision；Base64 只在内存中存在。', {
      actionId:{ type:'string', minLength:8, maxLength:160, pattern:'^[A-Za-z0-9:_-]+$' },
      relativePath:{ type:'string' },
      prompt:{ type:'string', maxLength:2000 }
    }, ['actionId', 'relativePath', 'prompt']),
    tool('stepfun-image-generate', 'StepFun 生图', '调用 step-image-edit-2 生成竖屏补充画面并写入受控工作区。', {
      actionId:{ type:'string', minLength:8, maxLength:160, pattern:'^[A-Za-z0-9:_-]+$' },
      prompt:{ type:'string', maxLength:512 },
      outputPath:{ type:'string' },
      seed:{ type:'integer', minimum:0 },
      textMode:{ type:'boolean' }
    }, ['actionId', 'prompt', 'outputPath']),
    tool('stepfun-image-edit', 'StepFun 图片编辑', '使用工作区内单张图片调用 step-image-edit-2 官方编辑接口，并将结果写回受控工作区。', {
      actionId:{ type:'string', minLength:8, maxLength:160, pattern:'^[A-Za-z0-9:_-]+$' },
      inputPath:{ type:'string' },
      prompt:{ type:'string', maxLength:512 },
      outputPath:{ type:'string' },
      seed:{ type:'integer', minimum:0 },
      textMode:{ type:'boolean' }
    }, ['actionId', 'inputPath', 'prompt', 'outputPath']),
    tool('stepfun-tts', 'StepFun 官方音色配音', '调用 stepaudio-2.5-tts；禁止克隆音色，写入受控工作区。', {
      actionId:{ type:'string', minLength:8, maxLength:160, pattern:'^[A-Za-z0-9:_-]+$' },
      text:{ type:'string', maxLength:1000 },
      voice:{ type:'string' },
      speed:{ type:'number', minimum:0.5, maximum:2 },
      outputPath:{ type:'string' }
    }, ['actionId', 'text', 'voice', 'outputPath']),
    tool('media-probe', '音视频规格检查', '用本机 ffprobe 检查编码、分辨率、时长和音轨，不执行任意命令。', {
      relativePath:{ type:'string' }
    }, ['relativePath']),
    tool('media-validate', '成片机器检查', '使用固定 ffprobe/ffmpeg 参数检查竖屏规格、黑帧、音轨和响度。', {
      relativePath:{ type:'string' },
      expectedDurationSeconds:{ type:'number', minimum:1, maximum:600 }
    }, ['relativePath']),
    tool('media-finalize', '受控最终编码', '只允许将工作区内输入编码为 H.264/AAC 竖屏成片，不接受任意命令或滤镜。', {
      inputPath:{ type:'string' },
      outputPath:{ type:'string' }
    }, ['inputPath', 'outputPath']),
    tool('remotion-props-write', '受控 Remotion Props 写入', '把运行时从可信 Work Product 派生的固定字段写入受控工作区；先执行同一套 Composition schema 和素材路径校验。', {
      composition:{ type:'string', enum:['M5Master', 'M5Douyin', 'M5Xiaohongshu'] },
      outputPath:{ type:'string' },
      props:{ type:'object' }
    }, ['composition', 'outputPath', 'props']),
    tool('remotion-render', '受控 Remotion 渲染', '只允许现有 M5 三个固定 Composition 读取 schema 化 props，并通过固定脚本写回对应成片。', {
      composition:{ type:'string', enum:['M5Master', 'M5Douyin', 'M5Xiaohongshu'] },
      propsPath:{ type:'string' },
      outputPath:{ type:'string' }
    }, ['composition', 'propsPath', 'outputPath']),
    tool('subtitle-layout-validate', '字幕布局门禁', '在渲染前检查字幕时间范围、重叠、行数和竖屏安全宽度。', {
      propsPath:{ type:'string' }
    }, ['propsPath']),
    tool('artifact-package-write', '固定产物包写入', '从可信三份成片、平台文案、真实封面素材、来源账本和审核结论生成固定产物清单；不调用模型。', {
      outputDir:{ type:'string' },
      videos:{ type:'object' },
      copies:{ type:'object' },
      coverSourcePath:{ type:'string' },
      sources:{ type:'object' },
      review:{ type:'object' },
      lineage:{ type:'object' },
      providerLedgerPath:{
        type:'string',
        description:'可选；含 StepFun 素材时指向受控工作区内已确认 Provider ledger，由插件原生补齐 action/cost/Prompt 血缘。'
      },
      providerThemeId:{
        type:'string',
        pattern:'^[A-Za-z0-9_-]{3,120}$',
        description:'可选；与 providerLedgerPath 同时提供，绑定账本内唯一主题。'
      },
      providerActionRefs:{
        type:'object',
        additionalProperties:false,
        properties:{
          image:{ type:'string', minLength:8, maxLength:160, pattern:'^[A-Za-z0-9:_-]+$' },
          vision:{ type:'string', minLength:8, maxLength:160, pattern:'^[A-Za-z0-9:_-]+$' },
          tts:{ type:'string', minLength:8, maxLength:160, pattern:'^[A-Za-z0-9:_-]+$' }
        },
        required:['image', 'vision', 'tts'],
        description:'可选；逐阶段 M5 使用。插件按同一 Paperclip Project 反查三条 confirmed 付费 action，调用方不能自行提交费用血缘。'
      }
    }, ['outputDir', 'videos', 'copies', 'coverSourcePath', 'sources', 'review', 'lineage']),
    tool('artifact-lineage-validate', '固定产物与血缘检查', '校验三份视频、双平台文案、封面、来源账本、审核报告和血缘哈希。', {
      manifestPath:{ type:'string' }
    }, ['manifestPath']),
    tool('publish-preflight', '发布确定性门禁', '校验机器审核、活动授权、幂等键、重复哈希和平台范围；不执行发布。', {
      campaignId:{ type:'string' },
      campaign:{ type:'object' },
      contentVersion:{ type:'object' },
      reviewReport:{ type:'object' },
      platform:{ type:'string', enum:['douyin', 'xiaohongshu'] },
      scheduledDate:{ type:'string' }
    }, ['campaignId', 'campaign', 'contentVersion', 'reviewReport', 'platform', 'scheduledDate'])
  ]
};

export default manifest;

function tool(name, displayName, description, properties, required) {
  const paid = name.startsWith('stepfun-');
  return {
    name,
    displayName,
    description,
    parametersSchema:{
      ...objectSchema,
      properties:paid
        ? { ...properties, budgetTicket:{ type:'string', minLength:100, maxLength:8000 } }
        : properties,
      required
    }
  };
}
