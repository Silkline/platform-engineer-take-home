import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface NetworkingArgs {
  cidrBlock?: string;
}

export class Networking extends pulumi.ComponentResource {
  public readonly vpcId: pulumi.Output<string>;
  public readonly vpcCidrBlock: pulumi.Output<string>;
  public readonly publicSubnetIds: pulumi.Output<string>[];
  public readonly privateSubnetIds: pulumi.Output<string>[];

  constructor(
    name: string,
    args: NetworkingArgs = {},
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("acme:net:Networking", name, args, opts);

    const cidr = args.cidrBlock ?? "10.0.0.0/16";
    const parent = { parent: this };

    const vpc = new aws.ec2.Vpc(
      `${name}-vpc`,
      {
        cidrBlock: cidr,
        enableDnsHostnames: true,
        enableDnsSupport: true,
        tags: { Name: name },
      },
      { ...parent, aliases: [{ name: "acme-vpc" }] },
    );

    // Public subnet A — aliased to the existing acme-public so an in-place
    // rollout preserves the resource instead of destroying it.
    const publicA = new aws.ec2.Subnet(
      `${name}-public-a`,
      {
        vpcId: vpc.id,
        cidrBlock: "10.0.1.0/24",
        availabilityZone: "us-east-1a",
        mapPublicIpOnLaunch: true,
        tags: { Name: `${name}-public-a` },
      },
      { ...parent, aliases: [{ name: "acme-public" }] },
    );

    const publicB = new aws.ec2.Subnet(
      `${name}-public-b`,
      {
        vpcId: vpc.id,
        cidrBlock: "10.0.2.0/24",
        availabilityZone: "us-east-1b",
        mapPublicIpOnLaunch: true,
        tags: { Name: `${name}-public-b` },
      },
      parent,
    );

    const privateA = new aws.ec2.Subnet(
      `${name}-private-a`,
      {
        vpcId: vpc.id,
        cidrBlock: "10.0.10.0/24",
        availabilityZone: "us-east-1a",
        tags: { Name: `${name}-private-a` },
      },
      parent,
    );

    const privateB = new aws.ec2.Subnet(
      `${name}-private-b`,
      {
        vpcId: vpc.id,
        cidrBlock: "10.0.11.0/24",
        availabilityZone: "us-east-1b",
        tags: { Name: `${name}-private-b` },
      },
      parent,
    );

    const igw = new aws.ec2.InternetGateway(
      `${name}-igw`,
      { vpcId: vpc.id, tags: { Name: `${name}-igw` } },
      { ...parent, aliases: [{ name: "acme-igw" }] },
    );

    const natEip = new aws.ec2.Eip(
      `${name}-nat-eip`,
      { domain: "vpc", tags: { Name: `${name}-nat-eip` } },
      parent,
    );

    const nat = new aws.ec2.NatGateway(
      `${name}-nat`,
      {
        allocationId: natEip.id,
        subnetId: publicA.id,
        tags: { Name: `${name}-nat` },
      },
      { ...parent, dependsOn: [igw] },
    );

    const publicRt = new aws.ec2.RouteTable(
      `${name}-public-rt`,
      {
        vpcId: vpc.id,
        routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
        tags: { Name: `${name}-public-rt` },
      },
      { ...parent, aliases: [{ name: "acme-public-rt" }] },
    );

    const privateRt = new aws.ec2.RouteTable(
      `${name}-private-rt`,
      {
        vpcId: vpc.id,
        routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: nat.id }],
        tags: { Name: `${name}-private-rt` },
      },
      parent,
    );

    new aws.ec2.RouteTableAssociation(
      `${name}-public-a-rta`,
      { subnetId: publicA.id, routeTableId: publicRt.id },
      { ...parent, aliases: [{ name: "acme-public-rta" }] },
    );

    new aws.ec2.RouteTableAssociation(
      `${name}-public-b-rta`,
      { subnetId: publicB.id, routeTableId: publicRt.id },
      parent,
    );

    new aws.ec2.RouteTableAssociation(
      `${name}-private-a-rta`,
      { subnetId: privateA.id, routeTableId: privateRt.id },
      parent,
    );

    new aws.ec2.RouteTableAssociation(
      `${name}-private-b-rta`,
      { subnetId: privateB.id, routeTableId: privateRt.id },
      parent,
    );

    this.vpcId = vpc.id;
    this.vpcCidrBlock = vpc.cidrBlock;
    this.publicSubnetIds = [publicA.id, publicB.id];
    this.privateSubnetIds = [privateA.id, privateB.id];

    this.registerOutputs({
      vpcId: this.vpcId,
      vpcCidrBlock: this.vpcCidrBlock,
      publicSubnetIds: this.publicSubnetIds,
      privateSubnetIds: this.privateSubnetIds,
    });
  }
}
