# The webkit CI job's browser install stalls on the apt mirror (2026-11-20)

The `test (webkit)` job's `install browser` step (`playwright install --with-deps webkit`) stalled twice in seven CI runs on 2026-11-20: on PR #29 (cancelled by hand after 25 minutes) and on PR #34 (run 44766869513, cancelled by the new 20-minute `timeout-minutes` from #32, as intended). The #34 log shows the cause: `apt` fetching webkit's system dependencies (`libavformat60`, `libssh-gcrypt-4` and others) from `azure.archive.ubuntu.com` at a few seconds per small package, still downloading when the job was cancelled. The chromium job installs far fewer system packages and never stalled. A re-run of the failed job passed both times.

The timeout now bounds the cost to one re-run. Cutting the cause would mean not reinstalling those packages on every run, for example by caching them or by using an image that already has them. That is a CI change for a human to decide.

Later the same day the chromium job hit it too: on PR #36 (run 44777978700) its `install browser` step took 11m49s of a 15m49s job, inside the 20-minute timeout, so the stall is the apt mirror and not only webkit's package list.
