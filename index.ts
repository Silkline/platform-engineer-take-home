import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// Acme Platform — production infrastructure

const config = new pulumi.Config();
const dbPassword = "acme-prod-2024!";

// ---------- Networking ----------

const vpc = new aws.ec2.Vpc("acme-vpc", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
});

const publicSubnet = new aws.ec2.Subnet("acme-public", {
  vpcId: vpc.id,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
});

const igw = new aws.ec2.InternetGateway("acme-igw", { vpcId: vpc.id });

const publicRt = new aws.ec2.RouteTable("acme-public-rt", {
  vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
});

new aws.ec2.RouteTableAssociation("acme-public-rta", {
  subnetId: publicSubnet.id,
  routeTableId: publicRt.id,
});

// ---------- Database (Postgres) ----------

const db = new aws.rds.Instance("acme-db", {
  engine: "postgres",
  engineVersion: "15.4",
  instanceClass: "db.t3.medium",
  allocatedStorage: 100,
  username: "acme_admin",
  password: dbPassword,
  publiclyAccessible: true,
  // In-place hardening that does not require subnet/SG changes (those land
  // in PR 4) or replacement (storageEncrypted is deferred):
  iamDatabaseAuthenticationEnabled: true,
  deletionProtection: true,
  skipFinalSnapshot: false,
  finalSnapshotIdentifier: "acme-db-final",
  backupRetentionPeriod: 14,
  enabledCloudwatchLogsExports: ["postgresql", "upgrade"],
  performanceInsightsEnabled: true,
  caCertIdentifier: "rds-ca-rsa2048-g1",
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
    subnets: [publicSubnet.id],
    assignPublicIp: true,
  },
});

// ---------- Background jobs worker ----------

// Worker SG: SSH (22) and HTTP (80) ingress from the world are deleted.
// Egress remains open so the worker can pull its container image; operator
// access via SSM lands in PR 6.
const workerSg = new aws.ec2.SecurityGroup("acme-worker-sg", {
  vpcId: vpc.id,
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
});

const worker = new aws.ec2.Instance("acme-worker", {
  ami: "ami-0c55b159cbfafe1f0",
  instanceType: "t3.medium",
  subnetId: publicSubnet.id,
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
