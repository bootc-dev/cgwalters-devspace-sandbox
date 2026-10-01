# The wfc-spike demo: a sandboxed agent proposes outputs, and a separate
# job with only the write permissions they need checks and applies them,
# the way gh-aw's safe outputs work. Compiled with wfc (cgwalters-forge/
# workflow-compiler, at the commit in .wfc-rev) to
# .github/workflows/safe-outputs-demo.lock.yml by ./wfc-compile.sh.
#
#   agent:  checkout and bot-harness setup as runner, then the agent in the
#           sandbox (runner-sandbox, no sudo, no token of the job's), on the
#           dispatcher's task; it writes safe-outputs/outputs.jsonl, which
#           is staged and uploaded after the seal.
#   apply:  workflow-compiler's safe_outputs macro (lib/safe-outputs.ncl):
#           checks the proposals in its own sandbox, then again in its
#           publish phase, and applies them with issues, contents and
#           pull-requests write.
let gha = import "../wfc/lib/gha.ncl" in
let agent_run = import "../wfc/lib/agent-run.ncl" in
let safe_outputs = import "../wfc/lib/safe-outputs.ncl" in

let SHARE = gha.share_dir in
let DEFAULT_TASK = "Say hello on the demo issue." in

let agent_job =
  let job = agent_run {
    prompt = "%{SHARE}/agentskills/safe-outputs.md",
    # No inference here yet (workflow-compiler#36): the scripted agent
    # runs the stub's commands in place of a model's.
    fake_script = [
      { execute = { title = "Bash", command = "bash %{SHARE}/agentskills/stub-agent.sh" } },
    ],
  }
  in
  job
  |> std.record.update "runner_steps" (job.runner_steps @ [
    # The dispatcher's task, as data: Actions passes the input to the
    # share action as an environment variable.
    { share = { name = "task", content = "${{ inputs.task || '%{DEFAULT_TASK}' }}" } },
  ])
  |> std.record.update "steps" (job.steps @ [
    safe_outputs.upload,
    # What the stub's sandbox checks printed, workflow commands included,
    # through the wrapper, which must neutralize them: it is the agent's
    # output, so annotations too, as in agent_run's own step (#60).
    { name = "Show the sandbox checks", "if" = "always()", run = "cat sandbox-checks.log", annotations = false },
  ])
  |> std.record.insert "permissions" { contents = "read" }
in

gha.compile {
  name = "Safe outputs demo",
  "run-name" = "Safe outputs demo (wfc-spike)",
  on = {
    workflow_dispatch.inputs.task = {
      description = "What the agent should do",
      type = "string",
      required = true,
      default = DEFAULT_TASK,
    },
    # GitHub dispatches only workflows it knows, and it learns of one on a
    # branch other than the default from a run: this push trigger is how
    # the spike branch's lock file got its first run.
    push = { branches = ["wfc-spike"], paths = [".github/workflows/safe-outputs-demo.lock.yml"] },
  },
  permissions = { contents = "read" },
  jobs = {
    agent = agent_job,
    apply = safe_outputs.apply {
      needs = "agent",
      repo = "bootc-dev/cgwalters-devspace-sandbox",
      types = {
        add_comment.targets = [12],
        create_pull_request = {
          base = "wfc-spike",
          allowed_paths = ["docs/**"],
          max_patch_bytes = 16384,
          branch_prefix = "wfc-spike-outputs/",
        },
        noop = {},
      },
    },
  },
}
