{{- define "discord-ai-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "discord-ai-agent.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "discord-ai-agent.name" . -}}
{{- end -}}
{{- end -}}

{{- define "discord-ai-agent.labels" -}}
app.kubernetes.io/name: {{ include "discord-ai-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "discord-ai-agent.commonEnv" -}}
- name: NODE_ENV
  value: production
- name: RUN_MIGRATIONS
  value: "false"
- name: BOT_NAME
  value: {{ .Values.config.botName | quote }}
- name: GITHUB_REPOSITORY
  value: {{ .Values.config.githubRepository | quote }}
- name: GITHUB_BASE_BRANCH
  value: {{ .Values.config.githubBaseBranch | quote }}
- name: OPENROUTER_CHAT_MODEL
  value: {{ .Values.config.openRouterChatModel | quote }}
- name: OPENROUTER_EMBEDDING_MODEL
  value: {{ .Values.config.openRouterEmbeddingModel | quote }}
- name: OPENROUTER_IMAGE_MODEL
  value: {{ .Values.config.openRouterImageModel | quote }}
- name: EMBEDDING_DIMENSIONS
  value: {{ .Values.config.embeddingDimensions | quote }}
- name: DISCORD_AGENT_RESPONSE_TIMEOUT_MS
  value: {{ .Values.config.discordAgentResponseTimeoutMs | quote }}
{{- end -}}

{{- define "discord-ai-agent.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.databaseUrlSecretKey }}
{{- end -}}

{{- define "discord-ai-agent.runtimeMigrationEnv" -}}
- name: RUN_MIGRATIONS
  value: "false"
{{- end -}}

{{- define "discord-ai-agent.internalApiEnv" -}}
- name: INTERNAL_API_PORT
  value: {{ .Values.api.port | quote }}
- name: TASK_SIGNING_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.taskSigningSecretKey }}
{{- end -}}

{{- define "discord-ai-agent.sandboxLauncherEnv" -}}
- name: CONTROL_PLANE_INTERNAL_URL
  value: http://{{ include "discord-ai-agent.fullname" . }}-api:{{ .Values.api.port }}
- name: KUBERNETES_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
- name: SANDBOX_IMAGE
  value: {{ .Values.sandbox.image | quote }}
- name: SANDBOX_IMAGE_PULL_POLICY
  value: {{ .Values.sandbox.imagePullPolicy | quote }}
- name: SANDBOX_SERVICE_ACCOUNT_NAME
  value: {{ .Values.sandbox.serviceAccountName | quote }}
- name: SANDBOX_CPU_REQUEST
  value: {{ .Values.sandbox.resources.requests.cpu | quote }}
- name: SANDBOX_CPU_LIMIT
  value: {{ .Values.sandbox.resources.limits.cpu | quote }}
- name: SANDBOX_MEMORY_REQUEST
  value: {{ .Values.sandbox.resources.requests.memory | quote }}
- name: SANDBOX_MEMORY_LIMIT
  value: {{ .Values.sandbox.resources.limits.memory | quote }}
- name: SANDBOX_TASK_TIMEOUT_SECONDS
  value: {{ .Values.sandbox.taskTimeoutSeconds | quote }}
- name: SANDBOX_TTL_SECONDS_AFTER_FINISHED
  value: {{ .Values.sandbox.ttlSecondsAfterFinished | quote }}
{{- end -}}

{{- define "discord-ai-agent.discordEnv" -}}
- name: DISCORD_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.discordTokenSecretKey }}
- name: DISCORD_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.discordClientIdSecretKey }}
- name: DISCORD_GUILD_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.discordGuildIdSecretKey }}
{{- end -}}

{{- define "discord-ai-agent.openRouterEnv" -}}
- name: OPENROUTER_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.openRouterApiKeySecretKey }}
{{- end -}}

{{- define "discord-ai-agent.githubEnv" -}}
- name: GITHUB_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.githubTokenSecretKey }}
      optional: true
- name: GITHUB_APP_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.githubAppIdSecretKey }}
      optional: true
- name: GITHUB_APP_PRIVATE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.githubAppPrivateKeySecretKey }}
      optional: true
- name: GITHUB_APP_INSTALLATION_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.githubAppInstallationIdSecretKey }}
      optional: true
{{- end -}}
