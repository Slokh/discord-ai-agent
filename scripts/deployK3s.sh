#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: deployK3s.sh <image-tag> <deployment-id> <bot-replicas> <namespace> <release> <registry> <repository>" >&2
  exit 64
fi

image_tag="$1"
deployment_id="$2"
bot_replicas="$3"
namespace="$4"
release="$5"
registry="$6"
repository="$7"
source_revision="${SOURCE_REVISION:-$image_tag}"

[[ "$image_tag" =~ ^[0-9a-f]{40}$ ]]
[[ "$source_revision" =~ ^[0-9a-f]{40}$ ]]
[[ "$deployment_id" =~ ^[A-Za-z0-9._-]+$ ]]
[[ "$bot_replicas" =~ ^[01]$ ]]
[[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]
[[ "$release" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]
[[ "$registry" =~ ^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ ]]
[[ "$repository" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*$ ]]

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
systemctl is-active --quiet k3s.service
systemctl start discord-ai-agent-bootstrap.service
systemctl start discord-ai-agent-ecr-refresh.service
kubectl get --raw=/readyz >/dev/null

workspace="$(mktemp -d)"
cleanup() { rm -rf "$workspace"; }
trap cleanup EXIT
curl -fsSL "https://github.com/Slokh/discord-ai-agent/archive/$source_revision.tar.gz" -o "$workspace/source.tar.gz"
mkdir "$workspace/source"
tar -xzf "$workspace/source.tar.gz" --strip-components=1 -C "$workspace/source"
cd "$workspace/source"

previous_helm_revision=""
previous_app_revision=""
if helm status "$release" --namespace "$namespace" --output json >"$workspace/previous.json" 2>/dev/null; then
  previous_helm_revision="$(jq -r '.version // empty' "$workspace/previous.json")"
fi
if kubectl --namespace "$namespace" get deployment "$release-bot" >/dev/null 2>&1; then
  previous_app_revision="$(kubectl --namespace "$namespace" get deployment "$release-bot" -o jsonpath='{.spec.template.spec.containers[?(@.name=="bot")].env[?(@.name=="APP_REVISION")].value}')"
fi

rollback_on_error() {
  status="$?"
  trap - ERR
  if [ -n "$previous_helm_revision" ]; then
    helm rollback "$release" "$previous_helm_revision" --namespace "$namespace" --wait --timeout 10m >/dev/null || true
  else
    kubectl --namespace "$namespace" scale deployment "$release-bot" --replicas=0 >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback_on_error ERR

helm upgrade --install "$release-database" deploy/helm/postgres \
  --namespace "$namespace" \
  --create-namespace \
  --set-string workload.existingClaim=discord-ai-agent-postgres-data \
  --set storage.createLocalPersistentVolume=true \
  --wait \
  --timeout 10m >/dev/null

helm_args=(
  --namespace "$namespace"
  --create-namespace
  --set "image.repository=$registry/$repository"
  --set "image.tag=$image_tag"
  --set "bot.replicas=$bot_replicas"
  --set-string "config.appRevision=$image_tag"
  --set-string "config.releaseVerificationId=$deployment_id"
)
if [ -n "$previous_app_revision" ]; then
  helm_args+=(--set-string "config.previousAppRevision=$previous_app_revision")
fi
if [ -n "${DISCORD_BOT_CHANNEL_ID:-}" ]; then
  helm_args+=(--set-string "config.botChannelId=$DISCORD_BOT_CHANNEL_ID")
fi

helm upgrade --install "$release" deploy/helm/discord-ai-agent \
  --rollback-on-failure \
  --wait \
  --timeout 10m \
  "${helm_args[@]}" >/dev/null

kubectl --namespace "$namespace" rollout status "statefulset/$release-postgres" --timeout=3m >/dev/null
kubectl --namespace "$namespace" rollout status "deployment/$release-worker" --timeout=3m >/dev/null
if [ "$bot_replicas" = "1" ]; then
  kubectl --namespace "$namespace" rollout status "deployment/$release-bot" --timeout=3m >/dev/null
else
  actual="$(kubectl --namespace "$namespace" get deployment "$release-bot" -o jsonpath='{.spec.replicas}')"
  [ "$actual" = "0" ]
fi

for component in bot worker; do
  expected="$bot_replicas"
  [ "$component" = worker ] && expected=1
  actual_image="$(kubectl --namespace "$namespace" get deployment "$release-$component" -o jsonpath='{.spec.template.spec.containers[0].image}')"
  actual_revision="$(kubectl --namespace "$namespace" get deployment "$release-$component" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="APP_REVISION")].value}')"
  actual_replicas="$(kubectl --namespace "$namespace" get deployment "$release-$component" -o jsonpath='{.status.readyReplicas}')"
  [ "$actual_image" = "$registry/$repository:$image_tag" ]
  [ "$actual_revision" = "$image_tag" ]
  [ "${actual_replicas:-0}" = "$expected" ]
done

permission="$(kubectl auth can-i create jobs.batch --namespace "$namespace" --as="system:serviceaccount:$namespace:$release-app" || true)"
[ "$permission" = "no" ]

table_count="$(kubectl --namespace "$namespace" exec "statefulset/$release-postgres" -- sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from information_schema.tables where table_schema = '\''public'\''"')"
[ "$table_count" -ge 66 ]

baseline="$(kubectl --namespace "$namespace" get pods -l "app.kubernetes.io/instance=$release" -o json | jq -c '[.items[] | {uid:.metadata.uid,restarts:([.status.containerStatuses[]?.restartCount] | add // 0)}] | sort_by(.uid)')"
sleep 30
stable="$(kubectl --namespace "$namespace" get pods -l "app.kubernetes.io/instance=$release" -o json | jq -c '[.items[] | {uid:.metadata.uid,restarts:([.status.containerStatuses[]?.restartCount] | add // 0)}] | sort_by(.uid)')"
[ "$baseline" = "$stable" ]

if [ "$bot_replicas" = "1" ]; then
  kubectl --namespace "$namespace" logs "deployment/$release-bot" | grep -Fq "Discord AI Agent Discord bot is online"
fi

kubectl --namespace "$namespace" exec "deployment/$release-worker" -- \
  node dist/scripts/markReleaseVerified.js --revision "$image_tag" --deployment-id "$deployment_id" >/dev/null

trap - ERR
printf '{"status":"passed","revision":"%s","botReplicas":%s,"postgresTables":%s}\n' "$image_tag" "$bot_replicas" "$table_count"
