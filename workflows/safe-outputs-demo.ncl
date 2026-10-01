# The wfc-spike demo: a sandboxed agent proposes outputs, a separate job
# with the one write permission validates and applies them, the way
# gh-aw's safe outputs work. Compiled with wfc (cgwalters-forge/
# workflow-compiler, at the commit in .wfc-rev) to
# .github/workflows/safe-outputs-demo.lock.yml by ./wfc-compile.sh.
#
#   agent:  checkout and bot-harness setup as runner, then the agent in the
#           sandbox (runner-sandbox, no sudo, no token of the job's), on the
#           dispatcher's task; it writes safe-outputs/outputs.jsonl, which
#           is staged and uploaded after the seal.
#   apply:  issues: write and nothing else. The proposals and the scripts
#           are shared into its sandbox, where validate.cjs checks them
#           against the config below; apply.cjs re-checks the result in
#           the publish phase and makes the writes.
let gha = import "../wfc/lib/gha.ncl" in
let agent_run = import "../wfc/lib/agent-run.ncl" in

let download = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" in # v8.0.1
let SHARE = gha.share_dir in
let DEFAULT_TASK = "Say hello on the demo issue." in

# What the apply job may do. The privileged phase shares it, so neither
# the agent nor the validator can change it.
let config = {
  repo = "bootc-dev/cgwalters-devspace-sandbox",
  max_total = 3,
  types = {
    add_comment = { max = 1, targets = [12], default_target = 12, max_body_bytes = 8192 },
    noop = { max = 1 },
  },
} in

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
    { "if" = "always()", upload = { name = "safe-outputs", path = "safe-outputs" } },
    # What the stub's sandbox checks printed, workflow commands included,
    # through the wrapper, which must neutralize them.
    { name = "Show the sandbox checks", "if" = "always()", run = "cat sandbox-checks.log" },
  ])
  |> std.record.insert "permissions" { contents = "read" }
in

let validated = "%{gha.staged "safe-outputs-validated"}/validated/validated.json" in

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
    apply = {
      needs = "agent",
      permissions = { issues = "write" },
      "timeout-minutes" = 10,
      # Nothing from the repository: the scripts come from the lock file.
      handoff.workspace = 'none,
      runner_steps = [
        { uses = download, with = { name = "safe-outputs", path = "proposals" } },
        { share = { name = "proposals", path = "proposals" } },
        { share = { name = "safe-outputs-config.json", content = std.serialize 'Json config } },
        { share = { name = "validate.cjs", content = import "../apply/validate.cjs" as 'Text } },
        { share = { name = "apply.cjs", content = import "../apply/apply.cjs" as 'Text } },
      ],
      steps = [
        {
          name = "Validate the proposals",
          run = "node %{SHARE}/validate.cjs %{SHARE}/safe-outputs-config.json %{SHARE}/proposals validated",
        },
        { upload = { name = "safe-outputs-validated", path = "validated" } },
      ],
      publish_steps = [
        {
          name = "Apply the validated outputs",
          run = "node %{SHARE}/apply.cjs %{SHARE}/safe-outputs-config.json %{validated}",
          env = { GITHUB_TOKEN = "${{ github.token }}" },
        },
      ],
    },
  },
}
