#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: runProductionCommand.sh <content-free-command>" >&2
  exit 64
fi

read -r -a instances <<<"$(aws ec2 describe-instances \
  --filters \
    'Name=tag:Role,Values=k3s' \
    'Name=tag:Environment,Values=production' \
    'Name=instance-state-name,Values=running' \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text)"
if [ "${#instances[@]}" -ne 1 ]; then
  echo "Expected exactly one running production K3s host; found ${#instances[@]}." >&2
  exit 1
fi

parameters="$(jq -cn --arg command "$1" '{commands:[$command]}')"
command_id="$(aws ssm send-command \
  --instance-ids "${instances[0]}" \
  --document-name AWS-RunShellScript \
  --comment "Run a content-free production operation" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"

status=Pending
for _ in $(seq 1 120); do
  status="$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "${instances[0]}" --query Status --output text)"
  case "$status" in
    Success) break ;;
    Failed|Cancelled|TimedOut|Cancelling)
      aws ssm get-command-invocation --command-id "$command_id" --instance-id "${instances[0]}" --query StandardOutputContent --output text || true
      aws ssm get-command-invocation --command-id "$command_id" --instance-id "${instances[0]}" --query StandardErrorContent --output text >&2 || true
      exit 1
      ;;
  esac
  sleep 5
done
test "$status" = Success
aws ssm get-command-invocation --command-id "$command_id" --instance-id "${instances[0]}" --query StandardOutputContent --output text
