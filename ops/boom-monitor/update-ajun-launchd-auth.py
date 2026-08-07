#!/usr/bin/env python3
from __future__ import annotations

import hmac
import os
import plistlib
import stat
import sys
import tempfile
from pathlib import Path


TOKEN_KEY = 'BOOM_MONITOR_BEARER_TOKEN'
ENABLED_KEY = 'AJUN_BOOM_MONITOR_ENABLED'


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {'rollback', 'verify-rollback', 'native', 'verify-native'}:
        raise SystemExit('用法: update-ajun-launchd-auth.py rollback|verify-rollback|native|verify-native <launchd plist>')
    action = sys.argv[1]
    target = Path(sys.argv[2])
    info = target.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit('launchd plist 必须是普通文件。')
    with target.open('rb') as stream:
        payload = plistlib.load(stream)
    environment = payload.get('EnvironmentVariables')
    if not isinstance(environment, dict):
        raise SystemExit('launchd plist 缺少 EnvironmentVariables。')

    if action in {'rollback', 'verify-rollback'}:
        token = sys.stdin.read()
        if token != token.strip() or len(token) < 32 or len(token) > 1024:
            raise SystemExit('回滚 Token 必须是当前 shell 提供的 32-1024 位无首尾空白字符串。')
        if str(environment.get(ENABLED_KEY, '')).strip().lower() != 'false':
            raise SystemExit('AJUN_BOOM_MONITOR_ENABLED 不是 false。')
        if action == 'rollback':
            environment[TOKEN_KEY] = token
            atomic_write(target, payload)
        elif not hmac.compare_digest(str(environment.get(TOKEN_KEY, '')), token):
            raise SystemExit('launchd 中的回滚 Token 与当前 shell 不一致。')
        return 0

    if action == 'native':
        environment.pop(TOKEN_KEY, None)
        environment[ENABLED_KEY] = 'true'
        atomic_write(target, payload)
        return 0

    if str(environment.get(ENABLED_KEY, '')).strip().lower() != 'true':
        raise SystemExit('AJUN_BOOM_MONITOR_ENABLED 不是 true。')
    if TOKEN_KEY in environment:
        raise SystemExit('native 模式 launchd 仍含回滚 Token。')
    return 0


def atomic_write(target: Path, payload: dict) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{target.name}.', dir=target.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            plistlib.dump(payload, stream, fmt=plistlib.FMT_XML, sort_keys=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        os.chmod(target, 0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == '__main__':
    raise SystemExit(main())
