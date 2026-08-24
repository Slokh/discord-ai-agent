{{- define "discord-ai-agent-postgres.fullname" -}}
{{- default .Chart.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "discord-ai-agent-postgres.labels" -}}
app.kubernetes.io/name: discord-ai-agent-postgres
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "discord-ai-agent-postgres.selectorLabels" -}}
app.kubernetes.io/name: discord-ai-agent-postgres
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgres
{{- end -}}
