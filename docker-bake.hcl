group "default" {
  targets = ["runtime", "codegen"]
}

target "runtime" {
  context = "."
  dockerfile = "Dockerfile"
  target = "final"
  tags = ["discord-ai-agent:ci-runtime"]
}

target "codegen" {
  context = "."
  dockerfile = "Dockerfile"
  target = "codegen"
  tags = ["discord-ai-agent:ci-codegen"]
}
