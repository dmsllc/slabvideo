# AGENTS.md

## Cursor Cloud specific instructions

This repository (`slabvideo`) is currently an empty project with only a `README.md`. There are no services, dependencies, build tools, or application code.

**Current state:**
- No package manager or lock file
- No source code or application entry point
- No tests, linters, or build scripts
- No external service dependencies (databases, caches, etc.)

**When code is added**, future agents should:
1. Re-evaluate this file and update instructions accordingly
2. Identify the package manager from lock files (`package-lock.json` → npm, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, `requirements.txt`/`pyproject.toml` → pip/uv)
3. Update the VM environment update script to install dependencies
