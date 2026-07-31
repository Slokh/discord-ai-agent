---
title: 'Generic bug-report requests can route to GitHub instead of the native inbox'
severity: 'minor'
issue: 'Slokh/discord-ai-agent#309'
---

## Expected Behavior

Unqualified requests such as “look at bug reports” should route to the requester-scoped Discord 🐛 marker inbox.

## Current Behavior

The repository guidance described marked-bug batches but did not explicitly disambiguate generic “bug reports” from GitHub issues, so an agent searched GitHub first.

## Possible Solution

Add an explicit routing rule to AGENTS.md and the engineering guide: use listDiscordBugMarkers by default and inspect GitHub only when the user names it.

## Minimal Reproducible Example

Ask a repository coding agent: “Look at bug reports.”

## Context

This caused unnecessary GitHub queries and delayed inspection of the product’s canonical native bug inbox.
