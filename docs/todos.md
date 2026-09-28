# Pending work

- [ ] **Move the version tests into a standalone module.** The version compatibility tests run from this package's test suite and from `scripts/compat.mjs`. The work is to move them into a standalone module that this package consumes.
- [ ] **Fix the truncated subagent results in DSH.** Subagent results are frequently truncated before the parent agent receives them. The work is to carry the complete result through to the parent.
