import path from 'node:path';

export const SUPPORTED_BROWSER_EXECUTABLES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
]);

export const BOUNDED_BROWSER_TOOLS = Object.freeze([
  'start_session',
  'end_session',
  'browser_prepare',
  'list_windows',
  'get_browser_state',
  'browser_navigate',
  'browser_set_input_files',
  'browser_type',
  'browser_click'
]);

export function renderBoundedBrowserPolicy({
  origin,
  readableDirectory,
  browserExecutable = null,
  profileMode = 'isolated_new',
  profileName = null,
}) {
  if (!path.isAbsolute(readableDirectory) || readableDirectory === path.parse(readableDirectory).root) {
    throw policyError('invalid_acceptance_directory', '策略中的测试目录必须是非根目录绝对路径。');
  }
  if (
    browserExecutable !== null
    && !SUPPORTED_BROWSER_EXECUTABLES.includes(browserExecutable)
  ) {
    throw policyError('unsupported_browser_executable', '策略只允许已审核的 Chrome、Chromium 或 Edge 可执行文件。');
  }
  if (
    !['isolated_new', 'isolated_named'].includes(profileMode)
    || (profileMode === 'isolated_named' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(profileName || '')))
    || (profileMode === 'isolated_new' && profileName !== null)
  ) {
    throw policyError('invalid_browser_profile', '策略只允许临时隔离 Profile 或获批的命名隔离 Profile。');
  }
  const tools = BOUNDED_BROWSER_TOOLS.map((tool) => `    - ${tool}`).join('\n');
  const appResources = browserExecutable
    ? [
      '  apps:',
      `    - executable: ${JSON.stringify(browserExecutable)}`,
      '      launch: true',
      '      windows: all',
      '      terminate: driver_launched'
    ]
    : ['  apps: []'];
  return [
    'version: 2',
    'mode: bounded',
    'expires_after: 15m',
    'idle_timeout: 5m',
    'resources:',
    ...appResources,
    '  browser:',
    '    profiles:',
    '      - kind: isolated',
    '    origins:',
    '      - about:blank',
    `      - ${JSON.stringify(origin)}`,
    '  desktop:',
    '    applications: []',
    '    windows: []',
    '    display: false',
    '  files:',
    '    read:',
    `      - dir: ${JSON.stringify(readableDirectory)}`,
    '        recursive: false',
    '    write: []',
    '  processes:',
    '    terminate: []',
    '  driver_configuration:',
    '    changes: []',
    'allow:',
    '  tools:',
    tools,
    'deny:',
    '  tools:',
    '    - page',
    'ask:',
    '  tools: []',
    ''
  ].join('\n');
}

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
