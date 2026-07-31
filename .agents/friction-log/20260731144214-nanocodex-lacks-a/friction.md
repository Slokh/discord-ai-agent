---
title: 'NanoCodex lacks a pinned Rust toolchain file'
severity: 'minor'
target: 'gakonst/nanocodex'
---

## Friction

Running the documented Cargo tests from a fresh checkout uses the ambient Rust 1.96 compiler and fails because the workspace requires Rust 1.97. The repository declares `rust-version = "1.97"` but does not include a `rust-toolchain.toml`, so contributors must manually discover and install/select the required compiler.

## Suggested improvement

Add a pinned `rust-toolchain.toml` or call out the exact `cargo +1.97.0 ...` invocation in contributor setup instructions.
