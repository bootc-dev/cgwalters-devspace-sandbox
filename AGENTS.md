# Agent instructions

The development-runner workflow intentionally remains `in_progress` as a
keepalive for the requested duration. After `cargo devspace start` returns, do
not wait for the workflow or its keepalive job to complete before connecting.
Connect while the run is active; `cargo devspace ssh RUN_ID` handles polling
until ordinary OpenSSH is ready.
