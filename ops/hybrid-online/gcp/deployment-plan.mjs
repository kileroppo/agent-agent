import path from 'node:path';

export const APPLY_CONFIRMATION = 'CREATE_PAID_GCP_RESOURCES';
export const MONTHLY_BUDGET = '35USD';

export const DEFAULT_GCP_DEPLOYMENT = Object.freeze({
  region:'us-central1',
  zone:'us-central1-a',
  instance:'agent-army-office',
  network:'agent-army-private',
  subnet:'agent-army-private-us-central1',
  firewall:'agent-army-iap-ssh',
  machineType:'e2-medium',
  bootDiskSize:'40GB',
  bootDiskType:'pd-standard',
  subnetRange:'10.42.0.0/24',
  imageFamily:'ubuntu-2404-lts-amd64',
  imageProject:'ubuntu-os-cloud'
});

export function buildDeploymentPlan(input = {}) {
  const definedInput = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const options = validateDeploymentOptions({ ...DEFAULT_GCP_DEPLOYMENT, ...definedInput });
  const startupScript = path.resolve(options.startupScript);
  return {
    options,
    services:['billingbudgets.googleapis.com', 'compute.googleapis.com', 'iap.googleapis.com'],
    resources:[
      {
        id:'network',
        kind:'network',
        name:options.network,
        describe:['compute', 'networks', 'describe', options.network],
        create:['compute', 'networks', 'create', options.network, '--subnet-mode=custom', '--bgp-routing-mode=regional']
      },
      {
        id:'subnet',
        kind:'subnet',
        name:options.subnet,
        describe:['compute', 'networks', 'subnets', 'describe', options.subnet, `--region=${options.region}`],
        create:[
          'compute', 'networks', 'subnets', 'create', options.subnet,
          `--network=${options.network}`,
          `--region=${options.region}`,
          `--range=${options.subnetRange}`,
          '--enable-private-ip-google-access'
        ]
      },
      {
        id:'firewall',
        kind:'firewall',
        name:options.firewall,
        describe:['compute', 'firewall-rules', 'describe', options.firewall],
        create:[
          'compute', 'firewall-rules', 'create', options.firewall,
          `--network=${options.network}`,
          '--direction=INGRESS',
          '--priority=1000',
          '--action=ALLOW',
          '--rules=tcp:22',
          '--source-ranges=35.235.240.0/20',
          '--target-tags=agent-army-iap'
        ]
      },
      {
        id:'instance',
        kind:'instance',
        name:options.instance,
        describe:['compute', 'instances', 'describe', options.instance, `--zone=${options.zone}`],
        create:[
          'compute', 'instances', 'create', options.instance,
          `--zone=${options.zone}`,
          `--machine-type=${options.machineType}`,
          `--network=${options.network}`,
          `--subnet=${options.subnet}`,
          '--network-tier=STANDARD',
          `--image-family=${options.imageFamily}`,
          `--image-project=${options.imageProject}`,
          `--boot-disk-size=${options.bootDiskSize}`,
          `--boot-disk-type=${options.bootDiskType}`,
          '--provisioning-model=STANDARD',
          '--maintenance-policy=MIGRATE',
          '--shielded-secure-boot',
          '--shielded-vtpm',
          '--shielded-integrity-monitoring',
          '--deletion-protection',
          '--no-service-account',
          '--no-scopes',
          '--tags=agent-army-iap',
          '--labels=app=agent-army,environment=production,managed-by=codex',
          '--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE',
          `--metadata-from-file=startup-script=${startupScript}`
        ]
      }
    ]
  };
}

export function validateDeploymentOptions(options) {
  const project = String(options.project || '').trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new DeploymentPlanError('Google Cloud 项目标识无效。');
  for (const [field, value] of Object.entries({
    instance:options.instance,
    network:options.network,
    subnet:options.subnet,
    firewall:options.firewall
  })) {
    if (!/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(String(value || ''))) {
      throw new DeploymentPlanError(`${field} 名称无效。`);
    }
  }
  const region = String(options.region || '');
  const zone = String(options.zone || '');
  if (!/^[a-z]+-[a-z]+\d$/.test(region) || !zone.startsWith(`${region}-`) || !/^[a-z]+-[a-z]+\d-[a-z]$/.test(zone)) {
    throw new DeploymentPlanError('区域或可用区无效。');
  }
  if (options.machineType !== 'e2-medium') throw new DeploymentPlanError('首版只允许经过评审的 e2-medium 规格。');
  if (options.bootDiskSize !== '40GB' || options.bootDiskType !== 'pd-standard') {
    throw new DeploymentPlanError('首版只允许 40GB 标准持久盘。');
  }
  if (options.subnetRange !== '10.42.0.0/24') throw new DeploymentPlanError('首版子网范围必须保持隔离基线。');
  if (!String(options.startupScript || '').trim()) throw new DeploymentPlanError('缺少主机引导脚本。');
  return { ...options, project, region, zone };
}

export function assertApplyAuthorized({ apply = false, confirmation = '', environment = process.env } = {}) {
  if (!apply) return;
  if (confirmation !== APPLY_CONFIRMATION || environment.AGENT_ARMY_GCP_APPLY !== APPLY_CONFIRMATION) {
    throw new DeploymentPlanError('付费资源执行门禁未满足；只允许输出预览。');
  }
}

export class DeploymentPlanError extends Error {}
