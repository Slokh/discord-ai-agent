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
- name: APP_REVISION
  value: {{ .Values.config.appRevision | quote }}
- name: BOT_NAME
  value: {{ .Values.config.botName | quote }}
- name: GITHUB_REPOSITORY
  value: {{ .Values.config.githubRepository | quote }}
- name: GITHUB_BASE_BRANCH
  value: {{ .Values.config.githubBaseBranch | quote }}
- name: OPENROUTER_CHAT_MODEL
  value: {{ .Values.config.openRouterChatModel | quote }}
{{- if .Values.config.openRouterUtilityModel }}
- name: OPENROUTER_UTILITY_MODEL
  value: {{ .Values.config.openRouterUtilityModel | quote }}
{{- end }}
{{- if .Values.config.openRouterCodegenModel }}
- name: OPENROUTER_CODEGEN_MODEL
  value: {{ .Values.config.openRouterCodegenModel | quote }}
{{- end }}
- name: OPENROUTER_EMBEDDING_MODEL
  value: {{ .Values.config.openRouterEmbeddingModel | quote }}
- name: OPENROUTER_IMAGE_MODEL
  value: {{ .Values.config.openRouterImageModel | quote }}
- name: EMBEDDING_DIMENSIONS
  value: {{ .Values.config.embeddingDimensions | quote }}
- name: DISCORD_AGENT_RESPONSE_TIMEOUT_MS
  value: {{ .Values.config.discordAgentResponseTimeoutMs | quote }}
- name: AGENT_PROMPT_MAX_CONCURRENCY
  value: {{ .Values.config.agentPromptMaxConcurrency | quote }}
- name: CHAT_SILENCE_TIMEOUT_MS
  value: {{ .Values.config.chatSilenceTimeoutMs | quote }}
- name: CHAT_HARD_TIMEOUT_MS
  value: {{ .Values.config.chatHardTimeoutMs | quote }}
- name: RETENTION_EVENTS_DAYS
  value: {{ .Values.config.retentionEventsDays | quote }}
- name: RETENTION_AUDIT_DAYS
  value: {{ .Values.config.retentionAuditDays | quote }}
- name: RETENTION_EMBEDDING_RUNS_DAYS
  value: {{ .Values.config.retentionEmbeddingRunsDays | quote }}
- name: RETENTION_RUNTIME_DAYS
  value: {{ .Values.config.retentionRuntimeDays | quote }}
- name: MEMORY_COMPACTION_THRESHOLD
  value: {{ .Values.config.memoryCompactionThreshold | quote }}
- name: MEMORY_COMPACTION_KEEP_RECENT
  value: {{ .Values.config.memoryCompactionKeepRecent | quote }}
- name: CRAWL_SCHEDULE_CRON
  value: {{ .Values.config.crawlScheduleCron | quote }}
- name: TOOLSET_SCOPING
  value: {{ .Values.config.toolsetScoping | quote }}
- name: WALLET_ENABLED
  value: {{ .Values.config.walletEnabled | quote }}
- name: USER_WALLETS_ENABLED
  value: {{ .Values.config.userWalletsEnabled | quote }}
- name: TEMPO_NETWORK
  value: {{ .Values.config.tempoNetwork | quote }}
- name: TEMPO_USD_TOKEN
  value: {{ .Values.config.tempoUsdToken | quote }}
- name: WALLET_INITIAL_GRANT_USD
  value: {{ .Values.config.walletInitialGrantUsd | quote }}
- name: WALLET_MAX_GAME_SETTLEMENT_USD
  value: {{ .Values.config.walletMaxGameSettlementUsd | quote }}
{{- if .Values.config.budgetUserTurnsPerDay }}
- name: BUDGET_USER_TURNS_PER_DAY
  value: {{ .Values.config.budgetUserTurnsPerDay | quote }}
{{- end }}
{{- if .Values.config.budgetUserImagesPerDay }}
- name: BUDGET_USER_IMAGES_PER_DAY
  value: {{ .Values.config.budgetUserImagesPerDay | quote }}
{{- end }}
{{- if .Values.config.budgetUserCodegenPerDay }}
- name: BUDGET_USER_CODEGEN_PER_DAY
  value: {{ .Values.config.budgetUserCodegenPerDay | quote }}
{{- end }}
{{- if .Values.config.budgetGuildDailyUsd }}
- name: BUDGET_GUILD_DAILY_USD
  value: {{ .Values.config.budgetGuildDailyUsd | quote }}
{{- end }}
- name: CODEGEN_HARNESS
  value: {{ .Values.codegen.harness | quote }}
- name: BOT_OWNER_USER_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.botOwnerUserIdSecretKey }}
      optional: true
- name: OPS_ALLOWLIST_USER_IDS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.opsAllowlistUserIdsSecretKey }}
      optional: true
- name: CODEGEN_ALLOWLIST_USER_IDS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.codegenAllowlistUserIdsSecretKey }}
      optional: true
- name: IMAGE_TOOLS_ALLOWLIST_ONLY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.imageToolsAllowlistOnlySecretKey }}
      optional: true
{{- end -}}

{{- define "discord-ai-agent.controlUiPublicEnv" -}}
{{- if .Values.config.controlUiPublicUrl }}
- name: CONTROL_UI_PUBLIC_URL
  value: {{ .Values.config.controlUiPublicUrl | quote }}
{{- end }}
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
- name: CONTROL_UI_AUTH_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.controlUiAuthPasswordSecretKey }}
      optional: true
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
- name: SANDBOX_CACHE_DIR
  value: {{ .Values.sandbox.cache.mountPath | quote }}
{{- if .Values.sandbox.cache.enabled }}
- name: SANDBOX_CACHE_PVC_NAME
  value: {{ include "discord-ai-agent.fullname" . }}-sandbox-cache
{{- end }}
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

{{- define "discord-ai-agent.discordIdentityEnv" -}}
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

{{- define "discord-ai-agent.spotifyEnv" -}}
- name: SPOTIFY_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.spotifyClientIdSecretKey }}
      optional: true
- name: SPOTIFY_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.spotifyClientSecretKey }}
      optional: true
{{- end -}}

{{- define "discord-ai-agent.paymentEnv" -}}
- name: PRIVY_APP_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.privyAppIdSecretKey }}
      optional: true
- name: PRIVY_APP_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secret.existingSecretName }}
      key: {{ .Values.config.privyAppSecretSecretKey }}
      optional: true
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
