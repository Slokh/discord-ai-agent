#!/usr/bin/env bash
set -euo pipefail

# Idempotent install of the server-side sandbox units (the agent join-token
# refresher, the stale sandbox Node cleanup, and the sandbox scaler) on the
# already-running production K3s host, so the host need not be replaced to adopt
# them. It copies their blocks verbatim from the server user data, retires the
# earlier agent-token publisher, and never modifies k3s.service. Pass --print to
# review the remote script without running it.

root="$(cd "$(dirname "$0")/.." && pwd)"
template="$root/deploy/terraform/aws/templates/k3s-user-data.sh.tftpl"

block() {
  local target="$1" text
  text="$(awk -v start="cat >$target <<'EOF'" '$0 == start { copying = 1 } copying { print } copying && $0 == "EOF" { exit }' "$template")"
  if [ -z "$text" ] || [ "$(printf '%s\n' "$text" | tail -n 1)" != "EOF" ]; then
    echo "Could not find the $target block in $template." >&2
    exit 1
  fi
  # A verbatim copy is only the rendered user data when nothing is interpolated.
  # shellcheck disable=SC2016
  if printf '%s\n' "$text" | grep -Fq -e '${' -e '%{'; then
    echo "The $target block uses template interpolation and cannot be copied verbatim." >&2
    exit 1
  fi
  printf '%s\n' "$text"
}

remote_script() {
  cat <<'PREAMBLE'
#!/usr/bin/env bash
set -euo pipefail
unit=/etc/systemd/system/k3s.service
# The server unit must already carry its original flags; this never edits it.
if grep -Eq -- '--(agent-)?token|discord-ai-agent-agent-token' "$unit"; then
  echo "k3s.service still references join-token flags; restore its original flags first." >&2
  exit 1
fi
grep -q '^AGENT_JOIN_SECRET_ARN=arn:' /etc/discord-ai-agent/runtime.env
systemctl is-active --quiet k3s.service
unit_digest="$(sha256sum "$unit")"

# Hosts booted before the scaler lack its runtime.env entry. Terraform names
# the pool <prefix>-k3s-sandbox and the join secret <prefix>/k3s/agent-join.
if ! grep -q '^SANDBOX_AUTOSCALING_GROUP=' /etc/discord-ai-agent/runtime.env; then
  prefix="$(sed -n 's|^AGENT_JOIN_SECRET_ARN=arn:aws:secretsmanager:[a-z0-9-]*:[0-9]*:secret:\([A-Za-z0-9_-]*\)/k3s/agent-join-[A-Za-z0-9]\{6\}$|\1|p' /etc/discord-ai-agent/runtime.env)"
  [ -n "$prefix" ]
  printf 'SANDBOX_AUTOSCALING_GROUP=%s-k3s-sandbox\n' "$prefix" >>/etc/discord-ai-agent/runtime.env
fi

# Retire the boot-time publisher and token generator from the agent-token design.
if [ -e /etc/systemd/system/discord-ai-agent-agent-join.service ]; then
  systemctl disable --now discord-ai-agent-agent-join.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/discord-ai-agent-agent-join.service
fi
rm -f /usr/local/sbin/discord-ai-agent-publish-agent-join /usr/local/sbin/discord-ai-agent-agent-token

PREAMBLE
  block /usr/local/sbin/discord-ai-agent-refresh-agent-join
  echo 'chmod 0755 /usr/local/sbin/discord-ai-agent-refresh-agent-join'
  echo
  block /etc/systemd/system/discord-ai-agent-agent-join-refresh.service
  echo
  block /etc/systemd/system/discord-ai-agent-agent-join-refresh.timer
  echo
  block /usr/local/sbin/discord-ai-agent-clean-sandbox-nodes
  echo 'chmod 0755 /usr/local/sbin/discord-ai-agent-clean-sandbox-nodes'
  echo
  block /etc/systemd/system/discord-ai-agent-sandbox-node-cleanup.service
  echo
  block /etc/systemd/system/discord-ai-agent-sandbox-node-cleanup.timer
  echo
  block /usr/local/sbin/discord-ai-agent-scale-sandbox
  echo 'chmod 0755 /usr/local/sbin/discord-ai-agent-scale-sandbox'
  echo
  block /etc/systemd/system/discord-ai-agent-sandbox-scaler.service
  cat <<'POSTAMBLE'

systemctl daemon-reload
systemctl start discord-ai-agent-agent-join-refresh.service
systemctl enable --now discord-ai-agent-agent-join-refresh.timer >/dev/null 2>&1
cleanup_started="$(date -u '+%Y-%m-%d %H:%M:%S')"
systemctl start discord-ai-agent-sandbox-node-cleanup.service
systemctl enable --now discord-ai-agent-sandbox-node-cleanup.timer >/dev/null 2>&1
# One direct pass first, so a missing grant or runtime.env entry fails here.
/usr/local/sbin/discord-ai-agent-scale-sandbox
systemctl enable discord-ai-agent-sandbox-scaler.service >/dev/null 2>&1
systemctl restart discord-ai-agent-sandbox-scaler.service
test "$(sha256sum "$unit")" = "$unit_digest"

printf 'k3s=%s\n' "$(systemctl is-active k3s.service)"
printf 'refresh=%s\n' "$(systemctl show -p Result --value discord-ai-agent-agent-join-refresh.service)"
printf 'timer=%s\n' "$(systemctl is-active discord-ai-agent-agent-join-refresh.timer)"
printf 'cleanup=%s\n' "$(systemctl show -p Result --value discord-ai-agent-sandbox-node-cleanup.service)"
printf 'cleanup_timer=%s\n' "$(systemctl is-active discord-ai-agent-sandbox-node-cleanup.timer)"
journalctl --utc --since "$cleanup_started" -u discord-ai-agent-sandbox-node-cleanup.service -o cat | grep '^Removed stale sandbox node ' || true
printf 'scaler=%s\n' "$(systemctl is-active discord-ai-agent-sandbox-scaler.service)"
printf 'sandbox_nodes=%s\n' "$(/usr/local/bin/k3s kubectl get nodes --selector discord-ai-agent.dev/pool=sandbox --no-headers | wc -l)"
/usr/local/bin/k3s kubectl --namespace kube-system get secrets \
  --field-selector type=bootstrap.kubernetes.io/token -o json \
  | jq -r '[.items[] | select((.data.description // "" | @base64d) == "sandbox-agent") | .data.expiration | @base64d]
    | "sandbox_agent_tokens=\(length) expires=\(join(","))"'
POSTAMBLE
}

if [ "${1:-}" = "--print" ]; then
  remote_script
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo "usage: installK3sSandboxServerUnits.sh [--print]" >&2
  exit 64
fi

script="$(remote_script)"
encoded="$(printf '%s\n' "$script" | base64 | tr -d '\n')"
if command -v sha256sum >/dev/null; then
  digest="$(printf '%s\n' "$script" | sha256sum | awk '{print $1}')"
else
  digest="$(printf '%s\n' "$script" | shasum -a 256 | awk '{print $1}')"
fi
# The remote script carries no secret; the host checks its digest before running it.
command="set -eu; f=\$(mktemp); trap 'rm -f \"\$f\"' EXIT; printf %s $encoded | base64 -d >\"\$f\"; printf '%s  %s\\n' $digest \"\$f\" | sha256sum --check --status; bash \"\$f\""
exec "$root/scripts/runProductionCommand.sh" "$command"
