Category: Builder → Intelligent Contracts

Title: PanelWeave: Uniform peer review assignment using future beacon consensus

Notes / Description:

PanelWeave draws a uniform peer review assignment from all valid matchings. Eligible reviewers sign submission commitments and conflict exclusions before an immutable cutoff. Leader and validators independently fetch a fixed future drand quicknet round from two relays, check the round and signature digest, and agree on the full pulse. A subset dynamic program counts valid assignments and unranking selects one using an unbiased rank. Each reviewer receives a unique submission and self review is excluded. An impossible panel records a checkable witness of reviewers with too few eligible submissions. GenVM lint and 17 tests passed. Two StudioNet panels verified 18 finalized receipts, including an assignment drawn from five valid matchings, a two-reviewer deficit and six expected rejections.

Evidence: [Contract source](contracts/panel_weave.py) · [StudioNet assignment](https://explorer-studio.genlayer.com/address/0x6bdE3857ce3E3F078c2a2fb34b0aF338c73A0D76) · [Onchain proofs](proofs/README.md)
