import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as rds from 'aws-cdk-lib/aws-rds';
import { InstanceClass, InstanceSize, InstanceType, Vpc, IpAddresses, SubnetType, SecurityGroup, Peer, Port } from 'aws-cdk-lib/aws-ec2';
import { MockIntegration, RestApi, Model, LambdaIntegration } from 'aws-cdk-lib/aws-apigateway';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Project, Source, GitHubSourceCredentials, ComputeType, LinuxBuildImage, BuildSpec, BuildEnvironmentVariableType } from 'aws-cdk-lib/aws-codebuild';
import { SecretValue } from 'aws-cdk-lib'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

export class CvGeneratorEnvStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //Create VPC
    const vpcName = "CVBuilderVPC";
    const defaultVPC = new Vpc(this, vpcName, {
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      createInternetGateway: true,
      availabilityZones: ['eu-west-1a', 'eu-west-1b'],
      subnetConfiguration: [
        {
          name: "cvbuilder-subnet-public",
          subnetType: SubnetType.PUBLIC
        },
        {
          name: "cvbuilder-subnet-private",
          subnetType: SubnetType.PRIVATE_ISOLATED,

        }

      ]
    });

    const subnets = defaultVPC.selectSubnets({ subnetType: SubnetType.PUBLIC });
    const securityGroup = new SecurityGroup(this, 'cv-builder-sg', {
      vpc: defaultVPC,
      allowAllOutbound: true,
      description: 'security group for a web server',
    });
    securityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(5432),
      'Allow POstgreSQL from anywhere'
    );

    //Create PostgreSQL database 
    const postgreName = "CVBuilderPostgreS";
    const dbName = "cvbuilder"
    const secretName = 'cvbuilder-postgres';
    const postgre = new rds.DatabaseInstance(this, postgreName, {
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      credentials: rds.Credentials.fromGeneratedSecret("poliakovaleek", { secretName: secretName }),
      vpc: defaultVPC,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      databaseName: dbName,
      vpcSubnets: subnets,
      multiAz: false,
      publiclyAccessible: true,
      securityGroups: [securityGroup]
    });


    // Create Lambda function
    const lambdaName = "CVBuilderLambdaFunction";
    const cvbuilderLambda = new Function(this, lambdaName, {
      functionName: lambdaName,
      runtime: Runtime.JAVA_17,
      timeout: cdk.Duration.minutes(2),
      environment: { 'SECRET_NAME': secretName },
      handler: 'com.my.corp.Handler::handle',
      code: Code.fromAsset('./assets/code'),
    //  vpc: defaultVPC,
    memorySize: 512,
      securityGroups: [securityGroup]
    });

    Secret.fromSecretNameV2(this, secretName, secretName).grantRead(cvbuilderLambda);

    // Create API gateway
    const api = new RestApi(this, 'CVBuilderAPi', {
      restApiName: 'CVBuilderAPI',
      description: 'My CDK test API',
      deploy: true,
      deployOptions: {
        stageName: 'alpha'
      }
    });
    const cvs = api.root.addResource('cvs');
    const mock = new MockIntegration(
      {
        requestTemplates: { 'application/json': '{statusCode: 200}' },
        integrationResponses: [{
          statusCode: '200', responseTemplates: { 'application/json': '' },
          responseParameters: {

          }
        }]
      }
    );
    const lambdaIntegration = new LambdaIntegration(cvbuilderLambda, {})
    cvs.addMethod('GET',
      lambdaIntegration,
      {
        methodResponses: [{
          statusCode: '200',
          responseModels: { 'application/json': Model.EMPTY_MODEL }
        }]
      });

    //Create S3 bucket
    const bucketName = 'cv-builder-bucket';
    const s3Bucket = new Bucket(this, bucketName, {
      bucketName: bucketName
    });



    // Create Code Build
    const projectName = 'CVBuilderProject';
    const gitHubCredentials = new GitHubSourceCredentials(this, 'GitHubCredentials', { accessToken: SecretValue.secretsManager('git-hub-access') });
    const src = Source.gitHub({
      owner: 'shureeck',
      repo: 'CVBuilder',
      branchOrRef: 'develop'
    });
    const env = { buildImage: LinuxBuildImage.AMAZON_LINUX_2_5, compute: ComputeType.SMALL };
    const codeBuildProject = new Project(this, projectName, {
      projectName: projectName,
      description: 'Test project that allow builds CVs and Resumes from templates',
      concurrentBuildLimit: 1,
      source: src,
      environment: env,
      environmentVariables: {
        'S3_BUCKET': { type: BuildEnvironmentVariableType.PLAINTEXT, value: s3Bucket.bucketName },
        'S3_KEY': { type: BuildEnvironmentVariableType.PLAINTEXT, value: 'code/CVBuilder-1.0.jar' },
        'LAMBDA_NAME': { type: BuildEnvironmentVariableType.PLAINTEXT, value: cvbuilderLambda.functionName }
      },
      buildSpec: BuildSpec.fromAsset('./assets/spec.yaml')
    });

    codeBuildProject.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['lambda:UpdateFunctionCode'],
      resources: [cvbuilderLambda.functionArn]
    }))

    s3Bucket.grantReadWrite(codeBuildProject);

  }
}
