# Acme Platform — Take-Home

Welcome, and thanks for spending an hour on this.

## Context

You're inheriting a Pulumi TypeScript repo that defines Acme's production AWS infrastructure: a Postgres database, a GraphQL gateway (Hasura on ECS Fargate), an S3 bucket for customer attachments, and a background-jobs worker on EC2.

This was shipped by a previous engineer in a hurry. It's been running in production for a few months. We're now bringing on a dedicated infra owner — you, hopefully — and the first thing you'll do is look at this code.

The README on the original commit said "production-ready ✅". We'd like your read on that.

## Your task

You have **60 minutes** to ship a pull request to your fork of this repo that meaningfully hardens this stack for production.

Three things to keep in mind:

1. **Pick your battles.** Don't try to fix everything. Fix what matters most.
2. **Write the PR description.** What you changed, what you deliberately left alone, what you'd do next with more time. The PR description is half of what we're evaluating.
3. **Use whatever tools you'd normally use.** Cursor, Claude, Copilot, ChatGPT, AWS docs, Stack Overflow — anything. We care about the result and your reasoning, not whether you've memorized Pulumi syntax.

## How to submit

1. Fork this repo to your personal GitHub account.
2. Make your changes on a branch in your fork.
3. Open a PR from your branch to your fork's `main`.
4. Reply to the email thread with the PR URL.

You **do not** need to run `pulumi up` or have an AWS account. Treat this as a code-review and design exercise. `pulumi preview` is not required either.

## What's in the repo

- `index.ts` — all the infrastructure code
- `Pulumi.yaml` — Pulumi project config
- `package.json` — npm dependencies

That's it. The whole stack is one file on purpose — pretend a more senior engineer (now gone) wrote this on a Friday afternoon.

## A few notes

- The repo uses `@pulumi/aws` v6 and `@pulumi/pulumi` v3.
- If you propose moving anything to a new file, package, or Pulumi component, **do it** — don't just describe it. We want to see your hands on the code.
- If you find yourself wanting more context about Acme (the company, the customers, the traffic), make reasonable assumptions and state them in the PR description.

Good luck.
