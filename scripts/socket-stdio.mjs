#!/usr/bin/env node
// Runs COMMAND with its stdio on sockets rather than pipes, copying this
// process's own stdio to and from them; exits as COMMAND does.
//
// run0 --pipe hands its stdio to PID 1 over D-Bus. Under SELinux, PID 1
// (init_t) may not read a pipe made by a service such as the Actions
// runner (unconfined_service_t), so the transfer fails and run0 reports
// "Connection reset by peer". Sockets are allowed, and Node's 'pipe'
// stdio is a socketpair, which is why commands run through spawnSync work.
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  process.stderr.write("usage: socket-stdio.mjs COMMAND [ARG...]\n");
  process.exit(2);
}
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
// The agent closing its stdin early is not an error here.
child.stdin.on("error", () => {});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (e) => {
  process.stderr.write(`socket-stdio: ${cmd}: ${e.message}\n`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  process.exitCode = code ?? 128 + ({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[signal] ?? 0);
  process.stdin.destroy();
});
