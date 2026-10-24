#!/usr/bin/env bash
# One scored, unrescued invocation: exactly `claude -p "/migrate-artifact src/utils/slugify.js"` in the disposable consumer.
set -u
E=$HOME/artifact-migration-acceptance/v1.6.2-336531c-claude-20261024
cd "$E/consumer" || exit 90
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_PID CLAUDE_CODE_MESSAGING_SOCKET \
  CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SSE_PORT CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_EXECPATH \
  CLAUDE_PLUGIN_DATA CLAUDE_EFFORT
echo "start=$(date -u +%FT%TZ) cwd=$PWD claude=$(claude --version)" > "$E/out/command.txt"
echo 'claude -p "/migrate-artifact src/utils/slugify.js"' >> "$E/out/command.txt"
timeout --kill-after=60 90m claude -p "/migrate-artifact src/utils/slugify.js" < /dev/null > "$E/out/agent.stdout.log" 2> "$E/out/agent.stderr.log"
rc=$?
echo "end=$(date -u +%FT%TZ) exit=$rc" >> "$E/out/command.txt"
exit $rc
