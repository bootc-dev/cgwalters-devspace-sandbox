# cgwalters-devspace-sandbox

The core idea: You want to do software development in an environment
that matches your CI.

And in the age of agentic AI, you want to [align your CI and AI](https://blog.verbum.org/2026/08/21/agentic-ai-and-software-forges/).

The idea behind this repository is simple: it's a playground that
can be force-pushed to arbitrarily and acts as the "dev space" for
one particular human (in this case, cgwalters).

There's a few bits of code you might find useful in this repository, but
the key thing is just the *ideas*. See below.

## Use cases

### Use case: Test CI workflows outside of a PR

Testing changes to CI by force pushing to a PR spams repository notifications.
Instead of that, force reset the `main` of your devspace to the target repository
you're working on, and then submit PRs against that instead.

Once that works, then do the PR against the actual repository.

### Use case: remote development target

GitHub supports `workflow_dispatch` to start a runner outside of an event (like a PR).

A generalization of this is *interactive login* to work on code.
GitHub [codespaces](https://github.com/features/codespaces) are a first
class thing on GitHub, but have their own costs and semantics.

In this repository, I have a workflow where the repository has an
oauth token that allows access to my personal [Tailnet](https://tailscale.com/);
the runner is accessible via ssh from my personal machines.

So then it's easy to do any hybrid you want - test some GHA YAML and then listen
on SSH, or just have it be "listen on SSH".

### Use case: Agent-driven remote development target

The next obvious generalization of this is: Give agentic AI to do all of
the above; the agent runs e.g. on your local machine, but can do the heavy
lifting on an ephemeral remote environment. It works really well.

### Use case: Agent-in-runner

A stricter evolution of the above is running the agent *in* the remote
environment. For more on this, see e.g. [agentic-job](https://github.com/cgwalters-forge/agentic-job/).

## Code

There's a small CLI in repository which adds a CLI usable by humans or
agents that abstracts over how this works, but is not required at all.

