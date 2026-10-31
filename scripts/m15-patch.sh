#!/usr/bin/env bash
# Complete BASE-to-worktree review artifact, stable before/after staging and commit.
set -euo pipefail
export LC_ALL=C
cd -- "$(dirname -- "$0")/.."
BASE=d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d
# Keep review hashing out of both the real index and the repository object store.
objects=$(git rev-parse --path-format=absolute --git-path objects)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export GIT_INDEX_FILE="$scratch/index" GIT_OBJECT_DIRECTORY="$scratch/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"
mkdir -- "$GIT_OBJECT_DIRECTORY"
git read-tree "$BASE"
git add -A -- .
git -c core.quotePath=true diff --cached --binary --full-index --no-ext-diff --no-textconv --no-renames --no-color --no-relative --diff-algorithm=myers --no-indent-heuristic --src-prefix=a/ --dst-prefix=b/ "$BASE" --
