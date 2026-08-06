#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
from datetime import datetime
from pathlib import Path
import time


def main() -> None:
    data_dir = Path(os.environ.get('BOOM_DATA_DIR', '/data'))
    backup_dir = Path(os.environ.get('BOOM_BACKUP_DIR', str(data_dir / 'backup')))
    backup_dir.mkdir(parents=True, exist_ok=True)

    while True:
        db_path = data_dir / 'boom-monitor.sqlite'
        if db_path.exists():
            ts = datetime.now().strftime('%Y%m%d-%H%M%S')
            target = backup_dir / f'boom-monitor-{ts}.sqlite'
            shutil.copy2(db_path, target)
            backups = sorted(backup_dir.glob('boom-monitor-*.sqlite'))
            for old in backups[:-14]:
                try:
                    old.unlink()
                except OSError:
                    pass
        time.sleep(24 * 60 * 60)


if __name__ == '__main__':
    main()
