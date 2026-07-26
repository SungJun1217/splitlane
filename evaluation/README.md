# Role-profile evaluation set

This directory defines a small, provider-neutral M0 evaluation set for the
initial role-routing hypothesis. It is not an automatic benchmark and does not
declare a permanent winner.

Every case must be run independently with both providers in read-only mode where
the task permits comparison. Builder/debugger cases use disposable fixture
repositories and isolated runs. A human records whether each required artifact
and rubric item is satisfied; provider self-confidence and raw output length do
not count as quality evidence.

Running these cases starts real model turns and therefore remains opt-in. No
ordinary automated test reads credentials or executes this set.
