Category: Builder → Intelligent Contracts

Title: PanelWeave: Uniform peer review assignment using future beacon consensus

Notes / Description:

PanelWeave draws a uniform peer review assignment from all valid matchings. Eligible reviewers sign their own submission commitments and conflict exclusions before an immutable cutoff. The contract pins a future drand quicknet round. Leader and validators independently fetch that exact round from two relays, check the round and signature digest, and agree on the full pulse. A subset dynamic program counts valid assignments and unranking selects one using an unbiased beacon-derived rank. Every reviewer receives a unique submission and self review is excluded. An impossible panel records a checkable witness showing which reviewers have too few eligible submissions. The contract records assignments, deadlines, entropy and failure witnesses onchain.
