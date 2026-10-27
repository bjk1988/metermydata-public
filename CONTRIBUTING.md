# Contributing to MeterMyData

Thank you. Two rules keep the project safe to use and safe to build on.

1. **Developer Certificate of Origin.** Every commit must be signed off (`git commit -s`), which certifies the [DCO 1.1](https://developercertificate.org/): you wrote the change or have the right to submit it under the MeterMyData License, and you license it under that License. Contributions are accepted under the MeterMyData License v1.0 (LICENSE.md), including its no-patent-grant and trademark terms.
2. **Measure, do not assert.** A change that affects numbers comes with a test that pins them. The chunking configuration `mmd-cdc-v1` is immutable; a different chunking is a new id with new vectors.

Bug reports: open an issue with the command you ran, the version (`npx metermydata --version`), your OS, and the report JSON if you can share it (it contains host names and byte counts, never content).
