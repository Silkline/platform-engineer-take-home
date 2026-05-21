import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// Acme Platform — production infrastructure
// Shipped by a previous engineer in a hurry. Production-ready ✅

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
  skipFinalSnapshot: true,
  storageEncrypted: false,
});

// ---------- Attachments bucket ----------

const attachments = new aws.s3.Bucket("acme-attachments", {
  acl: "public-read",
});

// ---------- GraphQL gateway (Hasura on Fargate) ----------

const cluster = new aws.ecs.Cluster("acme-cluster", {});

const taskRole = new aws.iam.Role("acme-task-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ecs-tasks.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("acme-task-role-admin", {
  role: taskRole.name,
  policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
});

const gatewayTask = new aws.ecs.TaskDefinition("acme-gateway", {
  family: "acme-gateway",
  cpu: "512",
  memory: "1024",
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  taskRoleArn: taskRole.arn,
  executionRoleArn: taskRole.arn,
  containerDefinitions: pulumi.interpolate`[{
    "name": "gateway",
    "image": "hasura/graphql-engine:v2.36.0",
    "portMappings": [{"containerPort": 8080}],
    "environment": [
      {"name": "HASURA_GRAPHQL_DATABASE_URL", "value": "postgres://acme_admin:${dbPassword}@${db.address}:5432/postgres"},
      {"name": "HASURA_GRAPHQL_ADMIN_SECRET", "value": "supersecret123"},
      {"name": "HASURA_GRAPHQL_ENABLE_CONSOLE", "value": "true"}
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

const workerSg = new aws.ec2.SecurityGroup("acme-worker-sg", {
  vpcId: vpc.id,
  ingress: [
    { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
    { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
  ],
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
