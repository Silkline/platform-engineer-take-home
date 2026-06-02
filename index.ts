import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { Networking } from "./src/networking";

// Acme Platform — production infrastructure

const config = new pulumi.Config();
const awsConfig = new pulumi.Config("aws");
const region = awsConfig.require("region");

// Lets `pulumi preview` render offline (dummy AWS credentials cannot
// resolve aws.ec2.getAmi). Real deployments omit this and let the
// lookup find the latest AL2023.
const workerAmiOverride = config.get("workerAmi");

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

// ---------- Secret material (random passwords + non-DB-dependent secrets) ----------
// dbConnectionString is composed below, after the RDS instance, since the
// URL value embeds db.address. The DB master password and the Hasura/worker
// secrets are independent of the RDS resource and live here so the RDS
// `password` field can consume dbPasswordValue.

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
  password: dbPasswordValue.result,
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

// ---------- Composed DB connection string (depends on db.address) ----------

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

const ecsTaskSg = new aws.ec2.SecurityGroup("acme-gateway-sg", {
  vpcId: net.vpcId,
  description: "Hasura task — ingress 8080 from world until ALB stack lands",
  egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
  ingress: [
    {
      protocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      cidrBlocks: ["0.0.0.0/0"],
      description: "Hasura GraphQL (public until ALB lands)",
    },
  ],
});

new aws.ec2.SecurityGroupRule("acme-rds-ingress-from-gateway", {
  type: "ingress",
  securityGroupId: rdsSg.id,
  protocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
  sourceSecurityGroupId: ecsTaskSg.id,
  description: "Hasura to Postgres",
});

const cluster = new aws.ecs.Cluster("acme-cluster", {});

const gatewayLogGroup = new aws.cloudwatch.LogGroup("acme-gateway-logs", {
  retentionInDays: 30,
});

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
  containerDefinitions: pulumi.jsonStringify([
    {
      name: "gateway",
      image: "hasura/graphql-engine:v2.36.0",
      portMappings: [{ containerPort: 8080 }],
      environment: [
        { name: "HASURA_GRAPHQL_ENABLE_CONSOLE", value: "false" },
      ],
      secrets: [
        {
          name: "HASURA_GRAPHQL_DATABASE_URL",
          valueFrom: dbConnectionString.arn,
        },
        {
          name: "HASURA_GRAPHQL_ADMIN_SECRET",
          valueFrom: hasuraAdminSecret.arn,
        },
      ],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": gatewayLogGroup.name,
          "awslogs-region": region,
          "awslogs-stream-prefix": "gateway",
        },
      },
    },
  ]),
});

const gatewayService = new aws.ecs.Service("acme-gateway-service", {
  cluster: cluster.arn,
  taskDefinition: gatewayTask.arn,
  desiredCount: 1,
  launchType: "FARGATE",
  networkConfiguration: {
    // Public subnet + public IP retained until the ALB follow-up stack
    // moves the task private and fronts it with a load balancer.
    subnets: [net.publicSubnetIds[0]],
    securityGroups: [ecsTaskSg.id],
    assignPublicIp: true,
  },
  deploymentMinimumHealthyPercent: 50,
  deploymentMaximumPercent: 200,
});

// ---------- Background jobs worker ----------
// workerSg is declared above (the database section needed it as an
// ingress source). Operator access uses SSM Session Manager — no SSH
// ingress, no public IP.

const workerRole = new aws.iam.Role("acme-worker-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ec2.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("acme-worker-ssm", {
  role: workerRole.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});

new aws.iam.RolePolicy("acme-worker-secrets", {
  role: workerRole.name,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: [dbConnectionString.arn, workerTokenSecret.arn],
      },
    ],
  }),
});

const workerProfile = new aws.iam.InstanceProfile("acme-worker-profile", {
  role: workerRole.name,
});

const workerAmi: pulumi.Input<string> = workerAmiOverride
  ? workerAmiOverride
  : aws.ec2.getAmiOutput({
      mostRecent: true,
      owners: ["amazon"],
      filters: [
        { name: "name", values: ["al2023-ami-*-x86_64"] },
        { name: "state", values: ["available"] },
      ],
    }).id;

const workerUserData = pulumi.interpolate`#!/bin/bash
set -euo pipefail

dnf install -y docker awscli
systemctl enable --now docker

DB_URL=$(aws secretsmanager get-secret-value --region ${region} --secret-id ${dbConnectionString.arn} --query SecretString --output text)
WORKER_TOKEN=$(aws secretsmanager get-secret-value --region ${region} --secret-id ${workerTokenSecret.arn} --query SecretString --output text)

docker run -d \\
  --restart unless-stopped \\
  -e DATABASE_URL="$DB_URL" \\
  -e WORKER_TOKEN="$WORKER_TOKEN" \\
  acmehq/jobs-worker:latest
`;

const worker = new aws.ec2.Instance("acme-worker", {
  ami: workerAmi,
  instanceType: "t3.medium",
  subnetId: net.privateSubnetIds[0],
  vpcSecurityGroupIds: [workerSg.id],
  associatePublicIpAddress: false,
  iamInstanceProfile: workerProfile.name,
  metadataOptions: {
    httpTokens: "required",
    httpEndpoint: "enabled",
    httpPutResponseHopLimit: 1,
  },
  rootBlockDevice: { encrypted: true },
  userData: workerUserData,
  tags: { Name: "acme-worker" },
});

export const dbEndpoint = db.endpoint;
