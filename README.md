# PanelWeave

PanelWeave assigns submissions for a small peer review panel. Each enrolled
participant reviews one other person's submission and receives one review.
The contract draws uniformly from the complete feasible assignments.

The constructor fixes a roster of three to eight addresses and an enrollment
duration in seconds. Each eligible address signs its own `enroll(sha256, exclusions)`
transaction. Exclusions are a comma-separated list of roster addresses that the
signer cannot review. They apply in that direction. Self review is always
excluded. A signer can withdraw before the cutoff. Nobody can modify the
roster, move the cutoff, or choose a different beacon round after deployment.

The deadline uses the transaction timestamp. The contract fixes the first
drand quicknet round scheduled at least 120 seconds after enrollment closes.
After that round is due, anyone can call `draw()`. The leader and each
validator independently fetch the exact round from the drand and Cloudflare
relays. They check the round number, signature encoding and SHA-256 of the
signature. Both relays and the validator's observation must match the leader's
complete normalized pulse. A relay error or disagreement leaves the panel
unresolved. Trust rests on those HTTPS relays and GenLayer consensus. The
contract checks the signature digest and relies on the relays for BLS signature
verification.

The contract counts feasible suffixes with a subset dynamic program in
O(n × 2ⁿ) time. A domain-separated hash mixes the agreed beacon, chain,
contract, round and frozen roster hash. Rejection sampling maps it to an
unbiased rank. Unranking skips entire ranges of completions to assign each
reviewer a unique submission. With fewer than three enrollments it records
`INSUFFICIENT`. If no perfect assignment exists it records `IMPOSSIBLE` and a
smallest Hall-deficit witness. That witness names reviewers whose combined
eligible submissions are fewer than the reviewers. Both failure outcomes can
resolve after enrollment closes without waiting for the beacon.

`get_state()` exposes the fixed schedule, signed commitments and final
assignment or witness. The contract assumes the roster organizer has chosen
distinct eligible reviewers. It records the assignment and the hash of each
submission. Submissions, review delivery and their contents are handled offchain.

References: [GenLayer transaction time](https://docs.genlayer.com/developers/intelligent-contracts/features/transaction-context) ·
[GenLayer equivalence](https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle) ·
[drand HTTP relays](https://docs.drand.love/developer/http-api/) ·
[quicknet parameters](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/)

```sh
pip install -r requirements-dev.txt
genvm-lint download --version v0.2.16
genvm-lint check contracts/panel_weave.py
python -m pytest tests/direct -q
node --test tests/rpc-preflight.test.cjs
```

The StudioNet workflow runs two synthetic panels. It checks each signed
transaction and compares the resulting state against a permutation oracle.
The assigned panel uses live drand randomness. Generic CLI transport and test
signing helpers are reused under MIT from
[ArchiveLift](https://github.com/gabrieladash123-bit/archive-lift).
