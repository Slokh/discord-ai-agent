group "default" {
  targets = ["runtime"]
}

# Release images: the runtime and the sandbox (codegen + desktop) image share
# one immutable source tag and are promoted together.
group "release" {
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
