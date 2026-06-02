import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { Networking } from "./src/networking";

// Acme Platform — production infrastructure

const config = new pulumi.Config();
const dbPassword = "acme-prod-2024!"; // replaced by dbPasswordValue.result in PR 5

// ---------- Networking ----------
// Aliases on the VPC, the public subnet, the IGW, the public route table,
// and the public RTA preserve the original resources when applied to a
// stateful stack. New private subnets and a NAT come up additively — no
// workload moves into them in this PR.

const net = new Networking("acme-net");

// ---------- Background-worker security group ----------
// Defined here (ahead of the database) so the RDS SG can reference it as
// an ingress source without a circular declaration. The EC2 worker that
// uses this SG is defined further down.

const workerSg = new aws.ec2.SecurityGroup("acme-worker-sg", {
  vpcId: net.vpcId,
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
});

// ---------- Database (Postgres) ----------

const dbSubnetGroup = new aws.rds.SubnetGroup("acme-db-subnets", {
  subnetIds: net.privateSubnetIds,
  description: "Private subnets for acme-db",
});

// Locked-down SG: no inline ingress, rules added as separate resources so
// rdsSg and the consumer SGs don't form a circular dependency.
const rdsSg = new aws.ec2.SecurityGroup("acme-rds-sg", {
  vpcId: net.vpcId,
  description: "Postgres — ingress 5432 from worker (and ECS task once PR 5 wires it)",
});

new aws.ec2.SecurityGroupRule("acme-rds-ingress-from-worker", {
  type: "ingress",
  securityGroupId: rdsSg.id,
  protocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
  sourceSecurityGroupId: workerSg.id,
  description: "Worker to Postgres",
});

const db = new aws.rds.Instance("acme-db", {
  engine: "postgres",
  engineVersion: "15.4",
  instanceClass: "db.t3.medium",
  allocatedStorage: 100,
  username: "acme_admin",
  password: dbPassword,
  // Network hardening — all in-place:
  publiclyAccessible: false,
  dbSubnetGroupName: dbSubnetGroup.name,
  vpcSecurityGroupIds: [rdsSg.id],
  multiAz: true,
  // From PR 1 (still here):
  iamDatabaseAuthenticationEnabled: true,
  deletionProtection: true,
  skipFinalSnapshot: false,
  finalSnapshotIdentifier: "acme-db-final",
  backupRetentionPeriod: 14,
  enabledCloudwatchLogsExports: ["postgresql", "upgrade"],
  performanceInsightsEnabled: true,
  caCertIdentifier: "rds-ca-rsa2048-g1",
});

// ---------- Secret material ----------
// Provisioned now; not yet consumed by RDS / Hasura / worker (those swaps
// land in PR 5 and PR 6). dbConnectionString carries the *new* random
// password — it's intentional that the value diverges from the live RDS
// credential here, because PR 5 atomically updates RDS to dbPasswordValue
// and switches Hasura to read this secret in the same `pulumi up`.

const dbPasswordValue = new random.RandomPassword("acme-db-password", {
  length: 32,
  special: false, // URL-safe: it ends up in postgres:// URLs
});

const hasuraAdminPasswordValue = new random.RandomPassword(
  "acme-hasura-admin-password",
  { length: 32, special: false },
);

const workerTokenValue = new random.RandomPassword("acme-worker-token-value", {
  length: 32,
  special: false,
});

const hasuraAdminSecret = new aws.secretsmanager.Secret("acme-hasura-admin", {
  description: "Hasura admin secret",
  recoveryWindowInDays: 7,
});
new aws.secretsmanager.SecretVersion("acme-hasura-admin-v1", {
  secretId: hasuraAdminSecret.id,
  secretString: hasuraAdminPasswordValue.result,
});

const workerTokenSecret = new aws.secretsmanager.Secret("acme-worker-token", {
  description: "Background worker auth token",
  recoveryWindowInDays: 7,
});
new aws.secretsmanager.SecretVersion("acme-worker-token-v1", {
  secretId: workerTokenSecret.id,
  secretString: workerTokenValue.result,
});

const dbConnectionString = new aws.secretsmanager.Secret(
  "acme-db-connection-string",
  {
    description: "Composed postgres:// URL for Hasura + worker",
    recoveryWindowInDays: 7,
  },
);
new aws.secretsmanager.SecretVersion("acme-db-connection-string-v1", {
  secretId: dbConnectionString.id,
  secretString: pulumi.interpolate`postgres://acme_admin:${dbPasswordValue.result}@${db.address}:5432/postgres`,
});

// ---------- Attachments bucket ----------

const attachments = new aws.s3.BucketV2(
  "acme-attachments",
  {},
  { aliases: [{ name: "acme-attachments", type: "aws:s3/bucket:Bucket" }] },
);

new aws.s3.BucketPublicAccessBlock("acme-attachments-pab", {
  bucket: attachments.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

new aws.s3.BucketOwnershipControls("acme-attachments-ownership", {
  bucket: attachments.id,
  rule: { objectOwnership: "BucketOwnerEnforced" },
});

new aws.s3.BucketServerSideEncryptionConfigurationV2("acme-attachments-sse", {
  bucket: attachments.id,
  rules: [
    { applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } },
  ],
});

new aws.s3.BucketVersioningV2("acme-attachments-versioning", {
  bucket: attachments.id,
  versioningConfiguration: { status: "Enabled" },
});

new aws.s3.BucketLifecycleConfigurationV2("acme-attachments-lifecycle", {
  bucket: attachments.id,
  rules: [
    {
      id: "abort-incomplete-multipart-uploads",
      status: "Enabled",
      abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
    },
  ],
});

// ---------- GraphQL gateway (Hasura on Fargate) ----------

const cluster = new aws.ecs.Cluster("acme-cluster", {});

const ecsAssumeRolePolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ecs-tasks.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

// Split the role the container assumes (taskRole — empty by default; the
// container doesn't need AWS API access today) from the role ECS uses to
// pull the image and resolve secrets (executionRole). Drops the previous
// AdministratorAccess grant entirely.
const executionRole = new aws.iam.Role("acme-gateway-exec", {
  assumeRolePolicy: ecsAssumeRolePolicy,
});

new aws.iam.RolePolicyAttachment("acme-gateway-exec-managed", {
  role: executionRole.name,
  policyArn:
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// Scoped Secrets Manager access for the ECS agent to resolve the new
// `secrets:` block (wired up in PR 5).
new aws.iam.RolePolicy("acme-gateway-exec-secrets", {
  role: executionRole.name,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: [dbConnectionString.arn, hasuraAdminSecret.arn],
      },
    ],
  }),
});

const taskRole = new aws.iam.Role("acme-gateway-task", {
  assumeRolePolicy: ecsAssumeRolePolicy,
});

const gatewayTask = new aws.ecs.TaskDefinition("acme-gateway", {
  family: "acme-gateway",
  cpu: "512",
  memory: "1024",
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  taskRoleArn: taskRole.arn,
  executionRoleArn: executionRole.arn,
  containerDefinitions: pulumi.interpolate`[{
    "name": "gateway",
    "image": "hasura/graphql-engine:v2.36.0",
    "portMappings": [{"containerPort": 8080}],
    "environment": [
      {"name": "HASURA_GRAPHQL_DATABASE_URL", "value": "postgres://acme_admin:${dbPassword}@${db.address}:5432/postgres"},
      {"name": "HASURA_GRAPHQL_ADMIN_SECRET", "value": "supersecret123"},
      {"name": "HASURA_GRAPHQL_ENABLE_CONSOLE", "value": "false"}
    ]
  }]`,
});

const gatewayService = new aws.ecs.Service("acme-gateway-service", {
  cluster: cluster.arn,
  taskDefinition: gatewayTask.arn,
  desiredCount: 1,
  launchType: "FARGATE",
  networkConfiguration: {
    subnets: [net.publicSubnetIds[0]],
    assignPublicIp: true,
  },
});

// ---------- Background jobs worker ----------
// (workerSg is declared above so the RDS SG can reference it as an
// ingress source. SSH/HTTP ingress was removed in PR 1; operator access
// via SSM lands in PR 6.)

const worker = new aws.ec2.Instance("acme-worker", {
  ami: "ami-0c55b159cbfafe1f0",
  instanceType: "t3.medium",
  subnetId: net.publicSubnetIds[0],
  vpcSecurityGroupIds: [workerSg.id],
  associatePublicIpAddress: true,
  userData: pulumi.interpolate`#!/bin/bash
docker run -d \\
  -e DATABASE_URL="postgres://acme_admin:${dbPassword}@${db.address}:5432/postgres" \\
  -e WORKER_TOKEN="trg_live_abc123def456" \\
  acmehq/jobs-worker:latest
`,
});

export const dbEndpoint = db.endpoint;
