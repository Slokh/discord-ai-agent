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
- name: APP_REVISION
  value: {{ .Values.config.appRevision | quote }}
{{- if .Values.config.releaseVerificationId }}
- name: RELEASE_VERIFICATION_ID
  value: {{ .Values.config.releaseVerificationId | quote }}
{{- end }}
{{- if .Values.config.previousAppRevision }}
- name: PREVIOUS_APP_REVISION
  value: {{ .Values.config.previousAppRevision | quote }}
{{- end }}
- name: BOT_OWNER_USER_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: BOT_OWNER_USER_ID, optional: true } }
- name: OPS_ALLOWLIST_USER_IDS
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: OPS_ALLOWLIST_USER_IDS, optional: true } }
{{- end -}}

{{- define "discord-ai-agent.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DATABASE_URL } }
{{- end -}}

{{- define "discord-ai-agent.sandboxCallbackEnv" -}}
- name: TASK_SIGNING_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: TASK_SIGNING_SECRET } }
{{- end -}}

{{- define "discord-ai-agent.sandboxLauncherEnv" -}}
- name: POD_NAMESPACE
  valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
- name: SANDBOX_IMAGE
  value: {{ .Values.sandbox.image | quote }}
{{- end -}}

{{- define "discord-ai-agent.discordEnv" -}}
- name: DISCORD_TOKEN
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DISCORD_TOKEN } }
- name: DISCORD_CLIENT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DISCORD_CLIENT_ID } }
- name: DISCORD_GUILD_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DISCORD_GUILD_ID } }
{{- if .Values.config.botChannelId }}
- name: DISCORD_BOT_CHANNEL_ID
  value: {{ .Values.config.botChannelId | quote }}
{{- end }}
- name: DISCORD_PREMIUM_SKU_IDS
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DISCORD_PREMIUM_SKU_IDS, optional: true } }
{{- end -}}

{{- define "discord-ai-agent.discordIdentityEnv" -}}
- name: DISCORD_CLIENT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DISCORD_CLIENT_ID } }
- name: DISCORD_GUILD_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DISCORD_GUILD_ID } }
{{- end -}}

{{- define "discord-ai-agent.consoleAuthEnv" -}}
{{- include "discord-ai-agent.discordIdentityEnv" . }}
- name: DISCORD_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: DISCORD_CLIENT_SECRET } }
- name: CONSOLE_SESSION_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: CONSOLE_SESSION_SECRET } }
{{- end -}}

{{- define "discord-ai-agent.openRouterEnv" -}}
- name: OPENROUTER_API_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: OPENROUTER_API_KEY } }
{{- end -}}

{{- define "discord-ai-agent.spotifyEnv" -}}
- name: SPOTIFY_CLIENT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: SPOTIFY_CLIENT_ID, optional: true } }
- name: SPOTIFY_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: SPOTIFY_CLIENT_SECRET, optional: true } }
{{- end -}}

{{- define "discord-ai-agent.paymentEnv" -}}
- name: PRIVY_APP_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: PRIVY_APP_ID, optional: true } }
- name: PRIVY_APP_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: PRIVY_APP_SECRET, optional: true } }
{{- end -}}

{{- define "discord-ai-agent.githubEnv" -}}
- name: GITHUB_TOKEN
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: GITHUB_TOKEN, optional: true } }
- name: GITHUB_APP_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: GITHUB_APP_ID, optional: true } }
- name: GITHUB_APP_PRIVATE_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: GITHUB_APP_PRIVATE_KEY, optional: true } }
- name: GITHUB_APP_INSTALLATION_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secret.existingSecretName }}, key: GITHUB_APP_INSTALLATION_ID, optional: true } }
{{- end -}}
