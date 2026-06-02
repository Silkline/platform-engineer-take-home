# Follow-ups

This branch closes the highest-impact security gaps in `index.ts` and stops short
of the items below. They were left out either because they exceed a 60-minute
take-home budget, because they require coordination outside the Pulumi program
(runbooks, app changes, DNS), or because they are net-positive but not
prerequisites for the deliberate flaws listed in `SECURITY.md`.

In an ideal world each row below would land as its own self-contained
[graphite](https://graphite.dev/) PR, stacked on top of this one. For ease of
review in a take-home, they are captured here as a backlog instead.

Notation:
- **Effort**: rough engineer-day estimate.
- **Blast radius**: what breaks (or who has to coordinate) if it goes wrong.
- **Why deferred**: the explicit reason this didn't ship in this PR.

---

## 1. RDS storage encryption (highest-priority gap left open)

**Effort:** 1–2 days · **Blast radius:** customer data, app downtime.

The one piece of RDS hardening AWS does not support in-place is enabling
`storageEncrypted: true` on an existing unencrypted volume. The supported path
is:

1. Take a manual snapshot of `acme-db`.
2. Copy the snapshot with `--kms-key-id` to produce an encrypted copy.
3. Restore the encrypted snapshot to a new RDS instance (`acme-db-encrypted`)
   with `snapshotIdentifier` set in Pulumi.
4. Drain writes against the old instance, validate row counts / checksums on
   the new one, then update `dbConnectionString` to point at the new endpoint
   and force a new ECS task-def revision so Hasura picks it up.
5. Retire the old `acme-db` after a soak period (~7 days), keeping its
   automated backups.

**Why deferred:** the Pulumi delta is small; the data-migration runbook is
substantial and requires DBA + on-call + app-team coordination. Not a 60-minute
exercise.

**Strategy choice (decide before scheduling the window):**

| Strategy | Downtime | Pulumi additions |
|---|---|---|
| Snapshot restore + write freeze | minutes–hours | `snapshotIdentifier` on the new instance |
| DMS with change data capture | seconds | DMS replication instance, endpoints, replication task |
| Postgres logical replication | seconds | Custom parameter group with `rds.logical_replication = 1` on the source |

Default recommendation: **snapshot restore** unless the downtime SLO is
strict — fewer moving parts, AWS-native, well-understood rollback.

---

## 2. Automatic Secrets Manager rotation

**Effort:** 0.5–1 day · **Blast radius:** brief connection-pool reset.

This PR rotates the DB master password **once** (PR 5) and stores the new
value as `dbConnectionString`. It does not yet rotate on a schedule.

Add:
- A Lambda rotator for the `dbConnectionString` secret. AWS publishes a
  reference rotation Lambda for RDS Postgres.
- An `aws.secretsmanager.SecretRotation` resource that schedules the Lambda
  (e.g. 30-day rotation, or a `Single user` strategy with no overlap).
- Same pattern for `hasuraAdminSecret` and `workerTokenSecret`, with custom
  rotation logic if the consuming apps need to be notified of the rotation.

This was deferred because of the Hasura DB URL composition: `manageMasterUserPassword: true`
would have given us rotation for free, but Hasura cannot natively assemble its
URL from a Secrets Manager-managed password without a runtime helper. The
Lambda rotator pattern is the workaround that preserves IaC-time URL composition.

---

## 3. ALB + ACM TLS + private-subnet move for Hasura

**Effort:** 1–2 days · **Blast radius:** customer-facing endpoint (DNS cutover).

Today the Hasura ECS task is still in a public subnet with `assignPublicIp: true`
because the task IP **is** the customer-facing endpoint. To move it private,
something else has to terminate inbound traffic.

Add:
- `aws.lb.LoadBalancer` (internet-facing, in `net.publicSubnetIds`).
- `aws.acm.Certificate` (DNS-validated via Route 53; requires a domain config knob).
- `aws.lb.Listener` on 443 (HTTPS, `ELBSecurityPolicy-TLS13-1-2-2021-06`)
  forwarding to a `TargetGroup` for the Hasura task on port 8080.
- A second `Listener` on 80 doing 443 redirect.
- New `albSg` (ingress 443 from world) and `ecsTaskSg` ingress restricted to
  `albSg` instead of `0.0.0.0/0`.
- ECS service moves to `net.privateSubnetIds`, `assignPublicIp: false`, and
  picks up a `loadBalancers` block pointing at the new target group.
- Customer DNS cutover from the public task IP to the ALB DNS name.

**Why deferred:** the user explicitly scoped this out, and rolling it into PR 4
would have entangled the RDS network move with the ALB introduction.

---

## 4. WAFv2 on the ALB

**Effort:** 0.5 day (after #3 ships) · **Blast radius:** false positives could
block legitimate traffic; start in `count` mode.

Attach an `aws.wafv2.WebAcl` to the ALB with AWS-managed rule groups:
`AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, and
`AWSManagedRulesAmazonIpReputationList`. Start each rule in `count` mode for
a week, review logs, then promote to `block`.

**Why deferred:** depends on #3 (no ALB to attach to yet).

---

## 5. CI: `pulumi preview` GitHub Actions workflow + Pulumi ESC + AWS OIDC

**Effort:** 1 day · **Blast radius:** none until adopted.

Today there is no CI gate. Add:
- A GitHub Actions workflow that runs `npm install && npx tsc --noEmit && pulumi preview`
  on every PR using the template stack config. Posts the preview output as a
  PR comment.
- Pulumi ESC environment for stack-wide config and secrets, layered as
  `silkline/acme/base` → `silkline/acme/aws-prod` → stack.
- AWS OIDC trust on the GitHub Actions OIDC provider so the workflow assumes
  a deployer role with **no static credentials** anywhere.

**Why deferred:** out of scope for the take-home repo (which uses the local
Pulumi backend), but the highest-value cross-cutting improvement once the
workload is shared by a team.

---

## 6. Refactor `Database`, `GatewayService`, `WorkerService` into ComponentResources

**Effort:** 1 day · **Blast radius:** none if aliases are correct.

Networking is already a `ComponentResource` (`acme:net:Networking`). The
remaining top-level resources in `index.ts` (~270 lines) would benefit from the
same treatment:

- `acme:rds:Database` wrapping RDS, SubnetGroup, rdsSg, and the SG rules.
- `acme:ecs:GatewayService` wrapping the cluster, log group, roles, task-def,
  service, SG.
- `acme:ec2:WorkerService` wrapping role, profile, SG, instance, user-data.

Each child needs `parent: this` and the URN change for existing resources
needs aliases so a stateful `pulumi up` shows update/no-op, not replace
(per `pulumi-best-practices` rules 3, 4, and 6).

**Why deferred:** the user explicitly scoped this out — "focus on security,
not on the structure". Networking was extracted only because the network
plumbing benefits most from reuse across stacks.

---

## 7. Customer-managed KMS keys for RDS, S3, Secrets Manager

**Effort:** 0.5 day · **Blast radius:** key permissions must be wired
correctly or workloads lose data access.

Today RDS storage (when encryption ships in #1), the S3 SSE configuration, and
all Secrets Manager secrets use AWS-managed KMS keys (`aws/rds`, `aws/s3`,
`aws/secretsmanager`). Replace with customer-managed keys
(`aws.kms.Key`), one per service, with explicit key policies allowing only
the relevant principals (the RDS service, the ECS execution role, the worker
instance profile).

CMKs unlock auditability (cross-account / cross-region key usage shows up in
CloudTrail), key rotation control, and the ability to revoke access by
disabling the key.

**Why deferred:** AWS-managed keys are the right default until there is a
concrete compliance or audit requirement.

---

## 8. VPC endpoints for Secrets Manager, ECR, S3

**Effort:** 0.5 day · **Blast radius:** low (additive, but tighten egress SGs
after to confirm endpoints work).

Today every Secrets Manager call from the ECS task / EC2 worker, every ECR
image pull, and every S3 access from inside the VPC traverses the NAT
gateway and the public internet. Adding:

- `aws.ec2.VpcEndpoint` interface endpoints for `com.amazonaws.us-east-1.secretsmanager`,
  `com.amazonaws.us-east-1.ecr.api`, `com.amazonaws.us-east-1.ecr.dkr`,
  `com.amazonaws.us-east-1.logs`.
- A gateway endpoint for `com.amazonaws.us-east-1.s3`.

…would cut NAT egress cost meaningfully and keep AWS API calls off the public
internet entirely. After endpoints are wired, the worker / ECS task SGs can
have their egress restricted to the endpoint SGs only.

**Why deferred:** straightforward but adds resources and per-AZ endpoint ENIs.
Not blocking for security; clearly net-positive for cost + attack surface.

---

## 9. ALB access logging to a dedicated logging bucket

**Effort:** 0.25 day (after #3) · **Blast radius:** none.

When #3 ships, attach `aws.s3.BucketLogging` so the ALB writes its access logs
to a dedicated logging bucket. The logging bucket should be encrypted with a
CMK and have a lifecycle rule moving logs to Glacier after 30 days.

**Why deferred:** depends on #3.

---

## 10. Pin the Hasura image to a digest

**Effort:** 5 minutes · **Blast radius:** none until next image update; then
a controlled rollover.

`hasura/graphql-engine:v2.36.0` is a tag. Tags are mutable — a malicious or
accidental tag push at the registry could change what runs. Switch to a
digest reference, e.g.
`hasura/graphql-engine@sha256:<digest>`. Track the upgrade as a deliberate PR
each time.

**Why deferred:** the digest pin would block the take-home reviewer from
seeing a fresh `pulumi preview`; not worth the friction. In a real codebase
this is a one-line change.

---

## 11. RDS minor-version auto-upgrades + major-version (15 → 16) upgrade plan

**Effort:** 0.5 day for auto-upgrade flag + maintenance window; 1–2 days for
the major upgrade (testing + cutover).

`autoMinorVersionUpgrade: true` is already on by default. Verify the maintenance
window is set explicitly (`maintenanceWindow: "Sun:04:00-Sun:05:00"`) so it
lands in known low-traffic hours.

Postgres 15 will go EOL in November 2027. Plan the 15 → 16 upgrade now: spin
up `acme-db-16` from a snapshot in staging, run the app's integration suite,
verify no SQL incompatibilities (most v15 → v16 upgrades are clean), then
schedule an in-place engine version bump on prod.

**Why deferred:** version bumps shouldn't be bundled with security cutovers —
they're their own change with their own rollback story.

---

## 12. VPC Flow Logs

**Effort:** 0.25 day · **Blast radius:** none.

Provision `aws.cloudwatch.LogGroup` + `aws.iam.Role` for
`vpc-flow-logs.amazonaws.com` + `aws.ec2.FlowLog` (traffic type `ALL`,
destination CloudWatch Logs). Useful for forensics and to validate the SG
lockdowns from PR 4.

**Why deferred:** observability / forensics, not blocking for the major
security issues this stack targets. The user explicitly asked to move this
out of the in-scope plan.

---

## Operational items (outside Pulumi scope, owned by ops / DBA / app team)

These are not Pulumi changes but they are prerequisites for several of the
items above and should be tracked alongside them.

### Data-migration runbook for #1 (RDS storage encryption)

Pulumi only provisions the new encrypted RDS instance once the snapshot ID is
known. The runbook covers: write-freeze window orchestration, snapshot
timing, row-count and checksum validation queries, app-team coordination for
the `dbConnectionString` secret value flip, rollback decision tree, smoke
tests post-cutover.

### Worker statelessness verification (before #1 ships its data migration is also relevant here)

PR 6 assumed `acme-worker` is queue-driven and idempotent — i.e. terminating
the EC2 instance does not lose in-flight job state. **Confirm with the app
team before the next `pulumi up` that replaces the worker.** If the worker
has local EBS state (in-flight job checkpoints, durable queue position,
etc.) the rollout needs its own data-migration step (snapshot the EBS volume,
drain the queue, etc.) and PR 6's preview should be re-examined.

### App-side: switch attachment serving to pre-signed S3 URLs

The S3 hardening in PR 1 (`BucketPublicAccessBlock` + drop of `acl: "public-read"`)
will break any client that was reading attachments via direct public S3 URLs.
Confirm with the app team that attachment access already goes through
pre-signed URLs; if not, that app change is a prerequisite for PR 1.

---

## Priority summary

| Tier | Items | Rationale |
|---|---|---|
| **P0** (next sprint) | #1 storage encryption, #2 auto rotation, #3 ALB+TLS, op item: worker statelessness | Material residual security gaps |
| **P1** (next quarter) | #4 WAFv2, #5 CI+ESC+OIDC, #6 component refactor, #8 VPC endpoints | Net-positive but not the most exposed surface |
| **P2** (opportunistic) | #7 CMK, #9 ALB access logs, #10 image digest, #11 RDS upgrades, #12 Flow Logs | Hygiene; lands cleanly any time |
