#!/usr/bin/env python3
"""Read or narrow one Hermes profile's enabled-skill set.

This helper deliberately uses Hermes' own skill discovery and configuration
functions. It never installs, uninstalls, deletes, or enables a skill.
"""

from __future__ import annotations

import json
import sys

from hermes_cli.config import load_config
from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills
from tools.skills_tool import _find_all_skills


def _visible_skill_names() -> set[str]:
    return {
        str(skill.get("name") or "").strip()
        for skill in _find_all_skills(skip_disabled=True)
        if str(skill.get("name") or "").strip()
    }


def _state() -> dict[str, list[str]]:
    visible = _visible_skill_names()
    disabled = get_disabled_skills(load_config())
    return {
        "visibleSkills": sorted(visible),
        "enabledSkills": sorted(visible - disabled),
        "disabledSkills": sorted(disabled),
    }


def _disable_only() -> dict[str, object]:
    payload = json.load(sys.stdin)
    requested = payload.get("disableSkills")
    if not isinstance(requested, list) or any(
        not isinstance(name, str) or not name.strip() for name in requested
    ):
        raise ValueError("disableSkills must be a list of non-empty skill names")

    requested_names = {name.strip() for name in requested}
    visible = _visible_skill_names()
    unknown = sorted(requested_names - visible)
    if unknown:
        raise ValueError(f"skills disappeared before apply: {', '.join(unknown)}")

    config = load_config()
    disabled = get_disabled_skills(config)
    newly_disabled = sorted(requested_names - disabled)
    if newly_disabled:
        save_disabled_skills(config, disabled | requested_names)
    return {
        "newlyDisabled": newly_disabled,
        **_state(),
    }


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else "inspect"
    if action == "inspect":
        result = _state()
    elif action == "disable-only":
        result = _disable_only()
    else:
        raise ValueError(f"unsupported action: {action}")
    sys.stdout.write(json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
