import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { CreateNewAccount } from "@awstesting-bangalore/create-newaccount";
import { BootstrapNewAccount } from "@awstesting-bangalore/bootstrap-newaccount";
import { ProvisionIamRoles } from "@awstesting-bangalore/provision-iamroles";
// import { DeployVpc } from "@aenetworks-gto/deploy-vpc";
// import { ConfigureCloudLogging } from "@aenetworks-gto/configure-cloudlogging";

const config = new pulumi.Config("appConfig");

// -----------------------------------------------------------------------------
// Cumulative Account Deployment Program
//
// Stage 1 - create_newaccount
// Stage 2 - bootstrap_newaccount
// Stage 3 - provision_iamroles
// Stage 4 - deploy_vpc
// Stage 5 - configure_cloudlogging
//
// currentStage:
//   The stage being actively requested for this run.
//
// lastCompletedStage:
//   The highest stage that must remain declared in this stack. This prevents
//   an IAM-only maintenance run from removing VPC / Cloud Logging resources
//   that are already part of the account stack.
//
// For a new account, Workato normally advances this value with each stage:
//   Stage 1 -> create_newaccount
//   Stage 2 -> bootstrap_newaccount
//   Stage 3 -> provision_iamroles
//   Stage 4 -> deploy_vpc
//   Stage 5 -> configure_cloudlogging
//
// After Stage 5, an IAM-only reconciliation can use:
//   currentStage: provision_iamroles
//   lastCompletedStage: configure_cloudlogging
//
// This keeps all existing Stage 4 / Stage 5 resources declared while IAM is
// being reconciled.
// -----------------------------------------------------------------------------

type CurrentStage =
    | "create_newaccount"
    | "bootstrap_newaccount"
    | "provision_iamroles"
    | "deploy_vpc"
    | "configure_cloudlogging";

const validStages: CurrentStage[] = [
    "create_newaccount",
    "bootstrap_newaccount",
    "provision_iamroles",
    "deploy_vpc",
    "configure_cloudlogging",
];

const stageRank: Record<CurrentStage, number> = {
    create_newaccount: 1,
    bootstrap_newaccount: 2,
    provision_iamroles: 3,
    deploy_vpc: 4,
    configure_cloudlogging: 5,
};

const currentStage = config.require("currentStage") as CurrentStage;
if (!validStages.includes(currentStage)) {
    throw new Error(`Invalid appConfig:currentStage '${currentStage}'. Valid values: ${validStages.join(", ")}`);
}

const lastCompletedStageValue = config.get("lastCompletedStage");
let lastCompletedStage: CurrentStage | undefined;

if (lastCompletedStageValue) {
    if (!validStages.includes(lastCompletedStageValue as CurrentStage)) {
        throw new Error(`Invalid appConfig:lastCompletedStage '${lastCompletedStageValue}'. Valid values: ${validStages.join(", ")}`);
    }
    lastCompletedStage = lastCompletedStageValue as CurrentStage;
}

const effectiveStageRank = Math.max(
    stageRank[currentStage],
    lastCompletedStage ? stageRank[lastCompletedStage] : 0,
);

const effectiveStage = validStages.find(
    (stage) => stageRank[stage] === effectiveStageRank,
)!;

const includesStage = (stage: CurrentStage): boolean =>
    effectiveStageRank >= stageRank[stage];

pulumi.log.info(`Current stage: ${currentStage}`);
pulumi.log.info(`Last completed stage: ${lastCompletedStage ?? "not-set"}`);
pulumi.log.info(`Effective desired-state stage: ${effectiveStage}`);

// -----------------------------------------------------------------------------
// Stage 1 - Create / Retain AWS Account
// -----------------------------------------------------------------------------

let createNewAccount: CreateNewAccount | undefined;
let createAccountName: string | undefined;
let createAccountDl: string | undefined;
let createAccountAlias: string | undefined;
let managedAccountId: string | undefined;

if (includesStage("create_newaccount")) {
    createAccountName = config.require("accountName");
    createAccountDl = config.require("accountDL");
    createAccountAlias = config.get("accountAlias") ?? createAccountName;

    const checkAliases = config.getBoolean("checkAliases");
    const checkAccountNames = config.getBoolean("checkAccountNames");
    const allowedPrefix = config.require("allowedPrefix");
    const forbiddenPrefixes = config.requireObject<string[]>("forbiddenPrefixes");
    managedAccountId = config.get("managedAccountId");

    const managementAccountRoleArn = config.require("managementAccountRoleArn");
    const managementBootstrapRoleArn = config.require("managementBootstrapRoleArn");
    const memberAccountRoleName = config.require("memberAccountRoleName");

    const managementProvider = new aws.Provider("management-account", {
        region: "us-east-1",
        assumeRoles: [{ roleArn: managementAccountRoleArn, sessionName: "pulumi-management-account" }],
    });

    createNewAccount = new CreateNewAccount(
        "create-newaccount",
        {
            accountName: createAccountName,
            accountDL: createAccountDl,
            accountAlias: createAccountAlias,
            checkAliases,
            checkAccountNames,
            allowedPrefix,
            forbiddenPrefixes,
            managedAccountId,
            managementAccountRoleArn,
            managementBootstrapRoleArn,
            memberAccountRoleName,
        },
        { providers: { aws: managementProvider } },
    );
}

// -----------------------------------------------------------------------------
// Stage 2 - Bootstrap New Account
// -----------------------------------------------------------------------------

let bootstrapNewAccount: BootstrapNewAccount | undefined;

if (includesStage("bootstrap_newaccount")) {
    const bootstrapAccountId = config.require("bootstrapAccountId");
    const bootstrapAccountName = config.require("bootstrapAccountName");
    const bootstrapAccountAlias = config.get("bootstrapAccountAlias") ?? bootstrapAccountName;
    const memberAccountRoleName =
    config.require("memberAccountRoleName");

    const targetAccountProvider = new aws.Provider("target-account", {
        region: "us-east-1",
        assumeRoles: [{
            roleArn: pulumi.interpolate`arn:aws:iam::${bootstrapAccountId}:role/${memberAccountRoleName}`,
            sessionName: "pulumi-bootstrap-newaccount",
        }],
    });

    bootstrapNewAccount = new BootstrapNewAccount(
        "bootstrap-newaccount",
        {
            accountId: bootstrapAccountId,
            accountName: bootstrapAccountName,
            accountAlias: bootstrapAccountAlias,
        },
        {
            providers: { aws: targetAccountProvider },
            dependsOn: createNewAccount ? [createNewAccount] : [],
        },
    );
}

// -----------------------------------------------------------------------------
// Stage 3 - Target-account IAM Roles
// -----------------------------------------------------------------------------

let provisionIamRoles: ProvisionIamRoles | undefined;
let iamRolesAccountId: string | undefined;
let iamDepartment: string | undefined;

if (includesStage("provision_iamroles")) {
    iamRolesAccountId = config.require("iamRolesAccountId");
    const iamIdentityAccountId = config.require("IdentityAccountId");
    const iamOrgAccountId = config.require("OrgAccountId");
    iamDepartment = config.require("Department");

    const iamStaticTags =
        config.getObject<Record<string, string>>("iamStaticTags") ??
        config.getObject<Record<string, string>>("staticTags") ??
        {};

    const restoreOrganizationAccountAccessRoleTrust =
        config.getBoolean("iamRestoreOrganizationAccountAccessRoleTrust") ?? true;
    const validatePermanentTargetRoleArn = config.require("iamValidatePermanentTargetRoleArn");
    const organizationAccountAccessRoleName =
        config.require("memberAccountRoleName");

    provisionIamRoles = new ProvisionIamRoles(
        "provision-iamroles",
        {
            accountId: iamRolesAccountId,
            department: iamDepartment,
            identityAccountId: iamIdentityAccountId,
            orgAccountId: iamOrgAccountId,
            staticTags: iamStaticTags,
            restoreOrganizationAccountAccessRoleTrust,
            validatePermanentTargetRoleArn,
            organizationAccountAccessRoleName,
        },
        { dependsOn: bootstrapNewAccount ? [bootstrapNewAccount] : [] },
    );
}

// // -----------------------------------------------------------------------------
// // Stage 4 - Deploy VPC
// // -----------------------------------------------------------------------------

// let deployVpc: DeployVpc | undefined;
// let vpcAccountId: string | undefined;
// let vpcAccountName: string | undefined;
// let vpcAccountAlias: string | undefined;
// let vpcRegion: string | undefined;
// let vpcEnvironment: string | undefined;
// let vpcCidr: string | undefined;

// const vpcRequired = config.getBoolean("vpcRequired") ?? true;

// if (includesStage("deploy_vpc") && vpcRequired) {
//     vpcAccountId = config.require("AccountId");
//     vpcAccountName = config.require("AccountName");
//     vpcAccountAlias = config.get("AccountAlias") ?? vpcAccountName;
//     vpcEnvironment = config.require("Environment");
//     vpcRegion = config.require("vpcRegion");
//     vpcCidr = config.require("vpcCidr");

//     const vpcRegionPrefix = config.get("vpcRegionPrefix");
//     const vpcConfig = config.requireObject<{
//         min: number;
//         max: number;
//         enableDnsSupport: boolean;
//         enableDnsHostnames: boolean;
//     }>("vpc");
//     const dhcpOptionsSet = config.requireObject<{
//         domainName: string;
//         domainNameServers: string[];
//     }>("dhcp_options_set");

//     const vpcStaticTags =
//         config.getObject<Record<string, string>>("vpcStaticTags") ??
//         config.getObject<Record<string, string>>("staticTags") ??
//         {};
//     const regionPrefixMap = config.getObject<Record<string, string>>("regionPrefixMap");

//     deployVpc = new DeployVpc(
//         "deploy-vpc",
//         {
//             accountId: vpcAccountId,
//             accountName: vpcAccountName,
//             accountAlias: vpcAccountAlias,
//             region: vpcRegion,
//             environment: vpcEnvironment,
//             vpcCidr,
//             regionPrefix: vpcRegionPrefix,
//             vpcNumber: vpcConfig.min,
//             enableDnsSupport: vpcConfig.enableDnsSupport,
//             enableDnsHostnames: vpcConfig.enableDnsHostnames,
//             domainName: dhcpOptionsSet.domainName,
//             domainNameServers: dhcpOptionsSet.domainNameServers,
//             staticTags: vpcStaticTags,
//             regionPrefixMap,
//         },
//         {
//             dependsOn: provisionIamRoles
//                 ? [provisionIamRoles]
//                 : bootstrapNewAccount
//                   ? [bootstrapNewAccount]
//                   : [],
//         },
//     );
// }

// // -----------------------------------------------------------------------------
// // Stage 5 - Configure Cloud Logging
// // -----------------------------------------------------------------------------

// let configureCloudLogging: ConfigureCloudLogging | undefined;
// let cloudLoggingAccountId: string | undefined;
// let cloudLoggingAccountName: string | undefined;

// if (includesStage("configure_cloudlogging")) {
//     cloudLoggingAccountId = config.require("AccountId");
//     cloudLoggingAccountName = config.require("AccountName");

//     const cloudLoggingAccountAlias = config.get("AccountAlias") ?? cloudLoggingAccountName;
//     const cloudLoggingRegion = config.require("cloudLoggingRegion");
//     const cloudLoggingRegionPrefix = config.get("cloudLoggingRegionPrefix");
//     const cloudLoggingEnvironment = config.require("Environment");

//     const cloudLoggingStaticTags =
//         config.getObject<Record<string, string>>("cloudLoggingStaticTags") ??
//         config.getObject<Record<string, string>>("staticTags") ??
//         {};

//     configureCloudLogging = new ConfigureCloudLogging(
//         "configure-cloudlogging",
//         {
//             accountId: cloudLoggingAccountId,
//             accountName: cloudLoggingAccountName,
//             accountAlias: cloudLoggingAccountAlias,
//             region: cloudLoggingRegion,
//             environment: cloudLoggingEnvironment,
//             regionPrefix: cloudLoggingRegionPrefix,
//             staticTags: cloudLoggingStaticTags,
//         },
//         {
//             dependsOn: deployVpc
//                 ? [deployVpc]
//                 : provisionIamRoles
//                   ? [provisionIamRoles]
//                   : bootstrapNewAccount
//                     ? [bootstrapNewAccount]
//                     : [],
//         },
//     );
// }

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

export const stage1_create_newaccount = createNewAccount
    ? {
          account_name: createNewAccount.accountName,
          account_dl: createNewAccount.accountDl,
          account_alias: createNewAccount.accountAlias,
          decision: createNewAccount.decision,
          actions_taken: createNewAccount.actionsTaken,
          account_id: createNewAccount.accountId,
          reason: createNewAccount.reason,
          duplicate: createNewAccount.duplicate,
      }
    : { status: "not_enabled" };

export const stage2_bootstrap_newaccount = bootstrapNewAccount
    ? {
          account_id: bootstrapNewAccount.accountId,
          account_name: bootstrapNewAccount.accountName,
          account_alias: bootstrapNewAccount.accountAlias,
          actions_taken: bootstrapNewAccount.actionsTaken,
          warnings: bootstrapNewAccount.warnings,
      }
    : { status: "not_enabled" };

export const stage3_iam_roles = provisionIamRoles
    ? {
          account_id: iamRolesAccountId,
          department: iamDepartment,
          role_names: provisionIamRoles.roleNames,
          trust_restore_status: provisionIamRoles.restoreTrustStatus,
      }
    : { status: "not_enabled" };

// export const stage4_deploy_vpc = deployVpc
//     ? {
//           account_id: vpcAccountId,
//           account_name: vpcAccountName,
//           account_alias: vpcAccountAlias,
//           region: vpcRegion,
//           environment: vpcEnvironment,
//           vpc_cidr: vpcCidr,
//           vpc_name: deployVpc.vpcName,
//           vpc_id: deployVpc.vpcId,
//           igw_name: deployVpc.igwName,
//           igw_id: deployVpc.igwId,
//           dos_name: deployVpc.dosName,
//           dos_id: deployVpc.dosId,
//           public_route_table_name: deployVpc.publicRouteTableName,
//           public_route_table_id: deployVpc.publicRouteTableId,
//           private_route_table_name: deployVpc.privateRouteTableName,
//           private_route_table_id: deployVpc.privateRouteTableId,
//           subnet_count: deployVpc.subnetCount,
//           subnets: deployVpc.subnets,
//           common_tags: deployVpc.commonTags,
//           resource_tags: deployVpc.resourceTags,
//       }
//     : includesStage("deploy_vpc") && !vpcRequired
//       ? { status: "not_required" }
//       : { status: "not_enabled" };

// export const stage5_cloud_logging = configureCloudLogging
//     ? {
//           account_id: configureCloudLogging.accountId,
//           account_name: configureCloudLogging.accountName,
//           region: configureCloudLogging.region,
//           region_prefix: configureCloudLogging.regionPrefix,
//           cloudtrail_names: configureCloudLogging.cloudTrailNames,
//           cloudtrail_arns: configureCloudLogging.cloudTrailArns,
//           cloudwatch_log_group_names: configureCloudLogging.cloudWatchLogGroupNames,
//           cloudwatch_log_group_arns: configureCloudLogging.cloudWatchLogGroupArns,
//           kms_key_arn: configureCloudLogging.kmsKeyArn,
//           kms_alias: configureCloudLogging.kmsKeyAlias,
//           cloudtrail_cloudwatch_role_arn: configureCloudLogging.cloudTrailCloudWatchLogsRoleArn,
//       }
//     : { status: "not_enabled" };

export const deployment_stage = currentStage;
export const last_completed_stage = lastCompletedStage ?? currentStage;
export const effective_desired_state_stage = effectiveStage;
export const managed_stages = validStages.filter(
    (stage) => stageRank[stage] <= effectiveStageRank,
);
