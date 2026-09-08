# Phase001 Root Validator Development Diagnostics

These immutable reports record failed development checks before the final
checkpoint regression. They are not PASS Gate evidence and do not replace any
required case, denominator, or independent Agent review.

| Report | Actual failure | Correction | SHA-256 |
| --- | --- | --- | --- |
| `root-validator-positive-1.json` | The positive isolated Git fixture exited 1 with `HISTORY_FILES`. The validator included the migration archive README in the set of 44 original Phase000 project files. | Compare the original project files against `docs/history/Phase000/docs/`; retain the entire archive's post-baseline immutability check. | `4404da2da8ef9459c9d7c5f95e97d7e6ca0761567cbf2056644238abc2b987f7` |
| `root-validator-positive-2.json` | The positive isolated Git fixture exited 1 because `git diff-tree` rejected the combined `-rz` option. | Pass `-r` and `-z` as separate arguments while retaining recursive, NUL-delimited raw Git path checks. | `2fa803ac7177807053c9017620bd7623d10022bd9af2a2c4667791ec4548e73b` |

Both reports were copied from their original generated `.scaffold` reports and
their raw SHA-256 values were compared after copying. Original reports remain
unchanged. The next isolated positive fixture passed under Windows PowerShell
5.1 and PowerShell 7, including root equality, empty Git prefix, local ignored
inputs, historical Phase000 import, adjacent commits, M0 contract coverage, and
a local-only bare-repository fast-forward push. The final complete regression
report is produced separately by the Phase001 evaluator.
