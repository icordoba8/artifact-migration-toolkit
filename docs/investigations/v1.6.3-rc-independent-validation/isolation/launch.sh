# usage: sh launch.sh <consumer> <agent-home> <store> -- cmd...   One launcher for dry-runs and the official run.
R=$1; H=$2; ST=$3; shift 4
S=<scratch>
mkdir -p "$H/tmp"
cd "$R" && exec env -i PATH=/opt/node22/bin:/usr/bin:/bin HOME="$H" TMPDIR="$H/tmp" CLAUDE_CODE_TMPDIR="$H/tmp" \
  ARTIFACT_MIGRATION_TOOLS_STORE="$ST" ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" NODE_EXTRA_CA_CERTS="$S/run163/ca.crt" \
  timeout 3600 unshare --user --map-root-user --mount --propagation private --pid --fork --mount-proc --kill-child \
  sh "$S/isolate-run.sh" "$R" "$H" -- "$@"
