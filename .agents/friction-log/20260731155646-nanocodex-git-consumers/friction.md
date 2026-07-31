---
title: 'NanoCodex Git consumers cannot resolve its patched reqwest feature'
severity: 'major'
target: 'gakonst/nanocodex'
---

NanoCodex declares reqwest 0.13.4 with the non-published rustls-ring feature and supplies a workspace-level [patch.crates-io] Git revision. Cargo does not propagate a dependency's workspace patches to downstream Git consumers, so a standalone crate depending on nanocodex at a pinned Git revision fails dependency resolution unless it repeats the exact reqwest patch. Please expose a directly consumable dependency setup or document/generate the required downstream patch.
