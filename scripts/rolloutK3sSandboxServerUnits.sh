#!/usr/bin/env bash
set -euo pipefail

# Operator rollout of the server-side sandbox units: a targeted Terraform plan of
# the two K3s launch templates and the server runtime policy, then the live-host
# installer. It refuses to run off a clean, current origin/main, refuses any plan
# that changes more than those resources' user data or policy, and asks before
# each production change. It never replaces an instance or touches k3s.service.
#
# usage: rolloutK3sSandboxServerUnits.sh --var-file <production.tfvars> [--plan-only]

root="$(cd "$(dirname "$0")/.." && pwd)"
terraform_dir="$root/deploy/terraform/aws"
profile="${AWS_PROFILE:-production-operator}"
var_file=""
plan_only=no

usage() {
  echo "usage: rolloutK3sSandboxServerUnits.sh --var-file <production.tfvars> [--plan-only]" >&2
  exit 64
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --var-file) [ "$#" -ge 2 ] || usage; var_file="$2"; shift 2 ;;
    --plan-only) plan_only=yes; shift ;;
    *) usage ;;
  esac
done
if [ -z "$var_file" ] || [ ! -f "$var_file" ]; then
  echo "Pass the production variables with --var-file (for example ~/.config/<prefix>/production.tfvars)." >&2
  exit 64
fi
var_file="$(cd "$(dirname "$var_file")" && pwd)/$(basename "$var_file")"
for tool in aws git jq terraform; do
  command -v "$tool" >/dev/null || { echo "Missing $tool." >&2; exit 1; }
done

step() { printf '\n==> %s\n' "$*"; }
confirm() {
  local answer
  printf '%s Type "%s" to continue: ' "$1" "$2" >/dev/tty
  read -r answer </dev/tty
  [ "$answer" = "$2" ] || { echo "Stopped; nothing further was changed." >&2; exit 1; }
}

step "Checking the checkout"
git -C "$root" fetch --quiet origin main
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "The checkout has uncommitted changes; roll out only from a clean main." >&2
  exit 1
fi
if [ "$(git -C "$root" rev-parse HEAD)" != "$(git -C "$root" rev-parse origin/main)" ]; then
  echo "HEAD is not origin/main; check out the current main first." >&2
  exit 1
fi
echo "main at $(git -C "$root" rev-parse --short HEAD)"

export AWS_PROFILE="$profile"
step "Current sandbox nodes"
"$root/scripts/runProductionCommand.sh" 'k3s kubectl get nodes -l discord-ai-agent.dev/pool=sandbox -o wide'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
step "Writing the installer's remote script for review"
"$root/scripts/installK3sSandboxServerUnits.sh" --print >"$work/remote.sh"
echo "Review $work/remote.sh in another terminal before confirming any change below."

step "Planning the launch templates and the server runtime policy"
eval "$(aws configure export-credentials --profile "$profile" --format env)"
terraform -chdir="$terraform_dir" plan -input=false -var-file="$var_file" \
  -target=aws_launch_template.k3s -target=aws_launch_template.k3s_sandbox \
  -target=aws_iam_role_policy.k3s_runtime -out="$work/k3s-join.tfplan"
terraform -chdir="$terraform_dir" show -json "$work/k3s-join.tfplan" >"$work/plan.json"

# Only in-place updates of these three resources, and only of these attributes.
unexpected="$(jq -r '
  {
    "aws_launch_template.k3s": ["user_data", "latest_version", "default_version"],
    "aws_launch_template.k3s_sandbox": ["user_data", "latest_version", "default_version"],
    "aws_iam_role_policy.k3s_runtime": ["policy"]
  } as $allowed
  | .resource_changes[]?
  | select(.mode == "managed" and .change.actions != ["no-op"])
  | . as $change
  | ([.change.before, .change.after] | map(. // {}) | add | keys) as $keys
  | [$keys[] | select(($change.change.before[.] != $change.change.after[.]) or ($change.change.after_unknown[.] == true))] as $changed
  | if ($allowed[.address] | not) then "\(.address): not part of this rollout"
    elif .change.actions != ["update"] then "\(.address): \(.change.actions | join(","))"
    elif ($changed - $allowed[.address] | length) > 0 then "\(.address): changes \($changed - $allowed[.address] | join(", "))"
    else empty end
' "$work/plan.json")"
if [ -n "$unexpected" ]; then
  echo "The plan changes more than this rollout allows; nothing was applied:" >&2
  printf '  %s\n' "$unexpected" >&2
  exit 1
fi
changes="$(jq -r '[.resource_changes[]? | select(.mode == "managed" and .change.actions == ["update"]) | .address] | join(" ")' "$work/plan.json")"
if [ -z "$changes" ]; then
  echo "The plan changes nothing; Terraform is already applied."
else
  echo "Plan updates only: $changes"
fi
if [ "$plan_only" = yes ]; then
  echo "Stopping after the plan (--plan-only)."
  exit 0
fi

if [ -n "$changes" ]; then
  confirm "Apply this plan? No instance is replaced." apply
  terraform -chdir="$terraform_dir" apply -input=false "$work/k3s-join.tfplan"
fi

step "Installing the server-side sandbox units on the running host"
confirm "Run the installer on production? It never edits k3s.service." install
"$root/scripts/installK3sSandboxServerUnits.sh" | tee "$work/install.out"
missing=""
for expected in k3s=active refresh=success timer=active cleanup=success cleanup_timer=active scaler=active sandbox_agent_tokens=1; do
  grep -Eq "(^| )$expected( |$)" "$work/install.out" || missing="$missing $expected"
done
if [ -n "$missing" ]; then
  echo "The installer finished without:$missing" >&2
  exit 1
fi

step "Rollout complete"
cat <<'EOF'
Live computer test: start a computer-profile task in Discord, then run
  AWS_PROFILE=production-operator scripts/runProductionCommand.sh 'journalctl -u discord-ai-agent-sandbox-scaler.service --since -1h -o cat'
Expect "Scaled the sandbox pool to 1" within about 20 seconds, a Ready sandbox
node a few minutes later, and "Scaled the sandbox pool to 0 after 10 idle
minutes." once the task has ended.
EOF
