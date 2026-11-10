group "default" {
  targets = ["runtime"]
}

group "release" {
  targets = ["runtime"]
}

target "runtime" {
  context = "."
  dockerfile = "Dockerfile"
  target = "final"
  tags = ["discord-ai-agent:ci-runtime"]
}
