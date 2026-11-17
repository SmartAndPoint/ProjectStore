#!/bin/sh
# projectstore — test fixture: a stub ssh command that never answers, for the
# dashboard write module's budget cases (the spec with alias
# `dashboard-writes`, "Testing").
#
#   sh dashboard-ssh-hang.sh <report.json> [git's ssh arguments…]
#
# Set as the vault repository's `core.sshCommand` over an `ssh://` origin.
# Its first act is the report, {"pid": <its pid>, "grandchild": <pid>}, so the
# report is there milliseconds after git starts it, also on a loaded runner,
# and no test waits on a Node start inside a budget. The grandchild is in the
# same process group and outlives a SIGTERM by 300 ms, as a slow ssh would: a
# call must not settle while it is still alive. Its process group is the git
# call's, which the spawn record names (`pid`). Asked `-G` (git's probe for an
# OpenSSH), it exits 1, so git speaks the simple variant to it.
report="$1"
shift
for a in "$@"; do
  [ "$a" = "-G" ] && exit 1
done
sh -c 'trap "sleep 0.3; exit 0" TERM; while :; do sleep 0.05; done' </dev/null >/dev/null 2>&1 &
printf '{"pid":%s,"grandchild":%s}\n' "$$" "$!" >"$report.tmp"
mv "$report.tmp" "$report"
while :; do sleep 1; done
