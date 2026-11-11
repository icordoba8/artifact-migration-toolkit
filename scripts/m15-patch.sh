#!/usr/bin/env bash
# Complete BASE-to-worktree review artifact, stable before/after staging and commit.
# BASE is the owner-approved comparison commit, approved at candidate pin time and always supplied
# explicitly as AMT_BASE: never inferred, never pinned in this file.
set -euo pipefail
export LC_ALL=C
cd -- "$(dirname -- "$0")/.."
BASE=${AMT_BASE:-}
[[ "$BASE" =~ ^[a-f0-9]{40}$ ]] || { echo "AMT_BASE must be the owner-approved full 40-character BASE commit" >&2; exit 1; }
git merge-base --is-ancestor "$BASE" HEAD || { echo "AMT_BASE $BASE is not an ancestor of HEAD" >&2; exit 1; }
# Keep review hashing out of both the real index and the repository object store.
objects=$(git rev-parse --path-format=absolute --git-path objects)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export GIT_INDEX_FILE="$scratch/index" GIT_OBJECT_DIRECTORY="$scratch/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"
mkdir -- "$GIT_OBJECT_DIRECTORY"
git read-tree "$BASE"
git add -A -- .
# The reviewed digest binds BASE too; git apply skips this preamble.
printf 'BASE %s\n' "$BASE"
git -c core.quotePath=true diff --cached --binary --full-index --no-ext-diff --no-textconv --no-renames --no-color --no-relative --diff-algorithm=myers --no-indent-heuristic --src-prefix=a/ --dst-prefix=b/ "$BASE" --
