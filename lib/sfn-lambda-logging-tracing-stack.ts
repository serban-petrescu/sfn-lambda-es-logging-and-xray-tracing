import { Tracing } from "@aws-cdk/aws-lambda";
import { NodejsFunction } from "@aws-cdk/aws-lambda-nodejs";
import { FilterPattern, LogGroup } from "@aws-cdk/aws-logs";
import { JsonPath, LogLevel, Map, Pass, Result, StateMachine } from "@aws-cdk/aws-stepfunctions";
import { LambdaInvoke } from "@aws-cdk/aws-stepfunctions-tasks";
import { CfnOutput, Construct, Duration, SecretValue, Stack, StackProps } from "@aws-cdk/core";
import { Domain, ElasticsearchVersion } from "@aws-cdk/aws-elasticsearch";
import { LambdaDestination } from "@aws-cdk/aws-logs-destinations";
import { PolicyStatement } from "@aws-cdk/aws-iam";

export class SfnLambdaLoggingTracingStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const generateInput = new Pass(this, "Pass", {
            result: Result.fromObject({ items: [{ message: "A" }, { message: "B" }, { message: "C" }] }),
        });

        const iterator = new Map(this, "Iterator", {
            itemsPath: JsonPath.stringAt("$.items"),
        });

        const lambdaFunction = new NodejsFunction(this, "Logger", {
            tracing: Tracing.ACTIVE,
        });

        const logGroup = new LogGroup(this, "LogGroup");

        const machine = new StateMachine(this, "Sfn", {
            definition: generateInput.next(iterator.iterator(new LambdaInvoke(this, "Lambda", { lambdaFunction }))),
            logs: {
                destination: logGroup,
                level: LogLevel.ALL,
            },
            tracingEnabled: true,
        });

        const ess = new Domain(this, "Es", {
            version: ElasticsearchVersion.V7_10,
            nodeToNodeEncryption: true,
            encryptionAtRest: { enabled: true },
            useUnsignedBasicAuth: true,
            enforceHttps: true,
            fineGrainedAccessControl: {
                masterUserName: "admin",
                masterUserPassword: SecretValue.plainText("P@ssw0rD"),
            },
        });

        const forwarder = new NodejsFunction(this, "Forwarder", {
            timeout: Duration.minutes(1),
            environment: {
                ES_DOMAIN_URL: ess.domainEndpoint,
            },
        });
        ess.grantReadWrite(forwarder);

        logGroup.addSubscriptionFilter("SfnLogsSubscription", {
            destination: new LambdaDestination(forwarder),
            filterPattern: FilterPattern.allEvents(),
        });
        lambdaFunction.logGroup.addSubscriptionFilter("LambdaLogsSubscription", {
            destination: new LambdaDestination(forwarder),
            filterPattern: FilterPattern.literal('[timestamp=*Z, request_id="*-*", event]'),
        });

        new CfnOutput(this, "StateMachineName", {
            value: machine.stateMachineName,
        });

        new CfnOutput(this, "LambdaRoleArn", {
            value: forwarder.role?.roleArn || "",
        });

        new CfnOutput(this, "KibanaUrl", {
            value: ess.domainArn + "/_plugin/kibana"
        });
    }
}
