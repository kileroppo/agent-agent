import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function script(relativePath) {
  return fs.readFileSync(path.resolve('ops/hybrid-online', relativePath), 'utf8');
}

test('本机归档先停写、使用 Paperclip 官方备份并排除原始数据库与运行垃圾', () => {
  const source = script('mac/prepare-cutover-archive.sh');
  const stopAjun = source.indexOf('launchctl bootout "$service_domain/$label"');
  const backup = source.indexOf('"$paperclip_node" "$paperclip_cli" db:backup');
  const stopPaperclip = source.indexOf('launchctl bootout "$service_domain/ai.agent-army.paperclip"');
  const copyProfiles = source.indexOf('copy_profile "$HOME/.hermes"');
  assert.ok(stopAjun > 0 && stopAjun < backup);
  assert.ok(backup < stopPaperclip && stopPaperclip < copyProfiles);
  assert.match(source, /PREPARE_PRIVATE_CUTOVER_ARCHIVE/);
  assert.match(source, /AGENT_ARMY_CUTOVER_ARCHIVE/);
  assert.match(source, /--exclude 'gateway\.pid'/);
  assert.match(source, /--exclude '\*\.db-wal'/);
  assert.doesNotMatch(source, /paperclip_instance\/db/);
  assert.match(source, /restore_local_services/);
  assert.match(source, /security add-generic-password/);
  assert.match(source, /--symmetric/);
  assert.match(source, /--cipher-algo AES256/);
});

test('上传只走 IAP 且上传动作不会导入或启动员工', () => {
  const source = script('mac/upload-cutover-archive.sh');
  assert.match(source, /TRANSFER_PRIVATE_CUTOVER_ARCHIVE/);
  assert.match(source, /AGENT_ARMY_CUTOVER_TRANSFER/);
  assert.match(source, /compute scp/);
  assert.match(source, /--tunnel-through-iap/);
  assert.match(source, /manifest_tool" verify/);
  assert.match(source, /security find-generic-password/);
  assert.match(source, /--decrypt/);
  assert.doesNotMatch(source, /activate-cutover\.sh|systemctl enable --now/);
});

test('云端代码只接受干净独立工作树的固定提交并通过 Git bundle 传输', () => {
  const source = script('mac/upload-release-bundle.sh');
  assert.match(source, /TRANSFER_COMMITTED_CLOUD_RELEASE/);
  assert.match(source, /AGENT_ARMY_RELEASE_TRANSFER/);
  assert.match(source, /worktree list --porcelain/);
  assert.match(source, /status --porcelain/);
  assert.match(source, /bundle create/);
  assert.match(source, /bundle verify/);
  assert.match(source, /--tunnel-through-iap/);
  assert.match(source, /checkout --quiet --detach/);
  assert.doesNotMatch(source, /systemctl enable --now|launchctl bootstrap/);
});

test('云端导入校验归档后恢复 Paperclip，但不启动任何 Hermes Gateway', () => {
  const source = script('cloud/import-cutover-state.sh');
  const verify = source.indexOf('manifest_tool" verify');
  const apply = source.indexOf('apply_tool" apply');
  const restore = source.indexOf('restore-paperclip.sh');
  assert.ok(verify > 0 && verify < apply && apply < restore);
  assert.match(source, /IMPORT_PRIVATE_CUTOVER_STATE/);
  assert.match(source, /AGENT_ARMY_CUTOVER_IMPORT/);
  assert.match(source, /systemctl disable --now/);
  assert.doesNotMatch(source, /systemctl enable --now.*hermes-gateway/);
});

test('云端激活必须持有本机停止证明并按 A君运行时、员工、总管顺序启动', () => {
  const source = script('cloud/activate-cutover.sh');
  const ajun = source.indexOf('systemctl enable --now agent-army-ajun-cloud.service');
  const employees = source.indexOf('hermes-gateway-intel-researcher.service \\\n  hermes-gateway-office-assistant.service');
  const manager = source.lastIndexOf('systemctl enable --now hermes-gateway.service');
  assert.match(source, /local-services-stopped\.json/);
  assert.match(source, /agent\.army\/local-services-stopped\/v1/);
  assert.ok(ajun > 0 && ajun < employees && employees < manager);
  assert.match(source, /rollback_cloud/);
});

test('Mac 切换失败时只在确认云端入口全部停止后恢复本机', () => {
  const source = script('mac/activate-cloud-cutover.sh');
  const rollbackStart = source.indexOf('restore_local_after_confirmed_cloud_stop()');
  const rollbackEnd = source.indexOf('\n}\n\nswitch_complete=', rollbackStart);
  const rollbackBody = source.slice(rollbackStart, rollbackEnd);
  assert.ok(rollbackBody.indexOf('remote_ssh "$stop_command"') < rollbackBody.indexOf('start_local_service'));
  assert.match(source, /无法确认云端入口已停止/);
  assert.match(source, /为避免双端接管/);
  assert.match(source, /SWITCH_EMPLOYEES_TO_PRIVATE_CLOUD/);
  assert.match(source, /AGENT_ARMY_CLOUD_SWITCH/);
});

test('显式本机回退先停止云端，云端状态不明时拒绝启动本机入口', () => {
  const source = script('mac/rollback-cutover-to-local.sh');
  const remoteStop = source.indexOf('compute ssh');
  const localBootstrap = source.indexOf('launchctl bootstrap');
  assert.ok(remoteStop > 0 && remoteStop < localBootstrap);
  assert.match(source, /ROLLBACK_EMPLOYEES_TO_LOCAL/);
  assert.match(source, /AGENT_ARMY_LOCAL_ROLLBACK/);
  assert.match(source, /拒绝启动本机入口/);
});
