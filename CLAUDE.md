# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pulumi infrastructure-as-code project ("Acme Platform") defining a production AWS stack in TypeScript. This is a **take-home interview exercise** where candidates harden a deliberately insecure infrastructure stack (see SECURITY.md for the list of intentional issues). No AWS account needed — use `pulumi preview` with the local backend and template config.

## Commands

```bash
npm install                                    # Install dependencies
npx tsc                                        # Compile TypeScript (outputs to bin/)
pulumi login --local                           # Use local backend (no AWS credentials needed)
pulumi stack init dev                          # Create dev stack
cp Pulumi.dev.template.yaml Pulumi.dev.yaml    # Set up local config for preview
pulumi preview                                 # Preview infrastructure changes offline
pulumi up                                      # Deploy (requires real AWS credentials)
```

No test or lint scripts are configured.

## Architecture

Single-file infrastructure definition (`index.ts`, ~137 lines) with all resources at the top level — no modules or abstractions. Creates:

- **VPC Networking**: VPC (10.0.0.0/16), public subnet, Internet Gateway, route tables
- **Database**: RDS PostgreSQL (db.t3.medium, 100GB)
- **GraphQL Gateway**: Hasura on ECS Fargate (512 CPU / 1024 MB)
- **Storage**: S3 bucket for customer attachments
- **Background Jobs**: EC2 instance (t3.medium) running Docker-based worker
- **IAM**: ECS task roles, instance profiles

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | All infrastructure resource definitions |
| `Pulumi.yaml` | Project metadata (name, runtime) |
| `Pulumi.dev.template.yaml` | Template config for local preview without AWS credentials |
| `SECURITY.md` | Lists the deliberately insecure patterns in the code |

## Agent Skills

This repo includes Pulumi agent skills in `.agents/skills/` (sourced from `pulumi/agent-skills` on GitHub, locked in `skills-lock.json`):

### pulumi-best-practices

Load when writing, reviewing, or debugging Pulumi TypeScript programs. Key rules:

1. **Never create resources inside `apply()`** — they won't appear in `pulumi preview`
2. **Pass Outputs directly as inputs** — don't unwrap values manually; use `pulumi.interpolate` for string interpolation
3. **Use ComponentResource for related resources** — group into reusable logical units with consistent URN patterns
4. **Always set `parent: this` in components** — ensures child resources appear nested under the component
5. **Encrypt secrets from day one** — use `config.requireSecret()` and `pulumi config set --secret`
6. **Use aliases when refactoring** — prevents destroy+recreate when renaming or reparenting resources
7. **Preview before every deployment** — always run `pulumi preview` before `pulumi up`

### pulumi-esc

Guidance for Pulumi ESC (Environments, Secrets, and Configuration) — centralized secrets, OIDC dynamic credentials, and environment composition. Key commands:

```bash
pulumi env init <org>/<project>/<env>           # Create environment
pulumi env set <org>/<project>/<env> key value --secret  # Set secret value
pulumi config env add <project>/<env>           # Link environment to stack
pulumi env run <org>/<project>/<env> -- <cmd>   # Run command with env vars
```

Best practices: use `fn::secret` for sensitive values, prefer OIDC over static keys, layer environments (base → cloud-provider → stack-specific), verify with `pulumi config` after linking.

## Pulumi Conventions

- Uses `@pulumi/aws` v6 and `@pulumi/pulumi` v3
- TypeScript strict mode enabled
- Config values accessed via `new pulumi.Config()`
- Stack outputs exported for cross-stack references
