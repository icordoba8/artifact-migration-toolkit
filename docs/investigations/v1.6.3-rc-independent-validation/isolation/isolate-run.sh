# Runs inside: unshare --user --map-root-user --mount --propagation private --pid --fork --mount-proc --kill-child
# usage: sh isolate-run.sh <consumer> <agent-home> -- cmd...
set -e
R=$1; H=$2; shift 3
mount -t tmpfs -o size=1m none /root
mount --bind /home /home && mount -o remount,bind,ro /home
mount --bind <tmp> <tmp> && mount -o remount,bind,ro <tmp>
for w in "$R" "$H"; do mount --bind "$w" "$w"; mount -o remount,bind,rw "$w"; done
for s in "$R/.claude/skills" "$R/.artifact-migration-tools/claude.json" "$R/.mcp.json"; do mount --bind "$s" "$s"; mount -o remount,bind,ro "$s"; done
exec setpriv --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"
