---
title: 'Release scan cannot allow an additional public fork owner'
severity: 'minor'
issue: 'Slokh/discord-ai-agent#310'
---

## Expected Behavior

The release scan should allow explicitly declared public dependency fork URLs.

## Current Behavior

The scanner rejects every occurrence of an additional public GitHub owner, forcing the dependency URL into an external Actions variable.

## Possible Solution

Support a narrow allowlist for declared public dependency repositories or a release-safe dependency manifest.

## Minimal Reproducible Example

Add a public fork URL as a pinned Docker build source and run `npm run scan:release`.

## Context

This appeared while pinning the NanoCodex fork used by the codegen image.
