import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { CreateNewAccount } from "@awstesting-bangalore/create-newaccount";
//import { BootstrapNewAccount } from "@aenetworks-gto/bootstrap-newaccount";


const config =
    new pulumi.Config("appConfig");


// -----------------------------------------------------------------------------
// Cumulative Account Deployment Program
//
// Stage 1 - create_newaccount
// Stage 2 - bootstrap_newaccount
// Stage 3 - provision_iamroles
// Stage 4 - deploy_vpc
// Stage 5 - configure_cloudlogging
//
// deployStage:
//   The stage being actively requested for this run.
//
// deployedThroughStage:
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
//   deployStage: provision_iamroles
//   deployedThroughStage: configure_cloudlogging
//
// This keeps all existing Stage 4 / Stage 5 resources declared while IAM is
// being reconciled.
// -----------------------------------------------------------------------------

type DeployStage =
    | "create_newaccount"
    | "bootstrap_newaccount"
    | "provision_iamroles"
    | "deploy_vpc"
    | "configure_cloudlogging";

const deployStage =
    config.require(
        "deployStage",
    ) as DeployStage;

const validStages:
    DeployStage[] = [
        "create_newaccount",
        "bootstrap_newaccount",
        "provision_iamroles",
        "deploy_vpc",
        "configure_cloudlogging",
    ];

if (
    !validStages.includes(
        deployStage,
    )
) {
    throw new Error(
        `Invalid appConfig:deployStage '${deployStage}'. ` +
        `Valid values: ${validStages.join(", ")}`,
    );
}

const stageRank:
    Record<DeployStage, number> = {
        create_newaccount:
            1,

        bootstrap_newaccount:
            2,

        provision_iamroles:
            3,

        deploy_vpc:
            4,

        configure_cloudlogging:
            5,
    };

const deployedThroughStageValue =
    config.get(
        "deployedThroughStage",
    );

let deployedThroughStage:
    DeployStage |
    undefined;

if (
    deployedThroughStageValue
) {
    if (
        !validStages.includes(
            deployedThroughStageValue as DeployStage,
        )
    ) {
        throw new Error(
            `Invalid appConfig:deployedThroughStage '${deployedThroughStageValue}'. ` +
            `Valid values: ${validStages.join(", ")}`,
        );
    }

    deployedThroughStage =
        deployedThroughStageValue as DeployStage;
}

const effectiveStageRank =
    Math.max(
        stageRank[deployStage],
        deployedThroughStage
            ? stageRank[deployedThroughStage]
            : 0,
    );

const effectiveStage =
    validStages.find(
        (stage) =>
            stageRank[stage] ===
            effectiveStageRank,
    )!;

const includesStage =
    (
        stage:
            DeployStage,
    ): boolean =>
        effectiveStageRank >=
        stageRank[stage];

pulumi.log.info(
    `Requested deployment stage: ${deployStage}`,
);

pulumi.log.info(
    `Stack deployed through stage: ${deployedThroughStage ?? "not-set"}`,
);

pulumi.log.info(
    `Effective desired-state stage: ${effectiveStage}`,
);


// -----------------------------------------------------------------------------
// Stage 1 - Create / Retain AWS Account
// -----------------------------------------------------------------------------
//
// Stage 1 MUST always use the management account, even during cumulative runs.
// The explicit management provider prevents later target-account provider
// configuration from accidentally moving account reconciliation into the
// member account.
// -----------------------------------------------------------------------------

let createNewAccount:
    CreateNewAccount |
    undefined;

let createAccountName:
    string |
    undefined;

let createAccountDl:
    string |
    undefined;

let createAccountAlias:
    string |
    undefined;

let managedAccountId:
    string |
    undefined;

if (
    includesStage(
        "create_newaccount",
    )
) {
    createAccountName =
        config.require(
            "accountName",
        );

    createAccountDl =
        config.require(
            "accountDL",
        );

    createAccountAlias =
        config.get(
            "accountAlias",
        ) ??
        createAccountName;

    const checkAliases =
        config.getBoolean(
            "checkAliases",
        ) ??
        true;

    managedAccountId =
        config.get(
            "managedAccountId",
        );

    const managementAccountRoleArn =
        config.require(
            "managementAccountRoleArn",
        );

    const managementProvider =
        new aws.Provider(
            "management-account",
            {
                region:
                    "us-east-1",

                assumeRoles: [
                    {
                        roleArn:
                            managementAccountRoleArn,

                        sessionName:
                            "pulumi-management-account",
                    },
                ],
            },
        );

    createNewAccount =
        new CreateNewAccount(
            "create-newaccount",
            {
                accountName:
                    createAccountName,

                accountDL:
                    createAccountDl,

                accountAlias:
                    createAccountAlias,

                checkAliases:
                    checkAliases,

                managedAccountId:
                    managedAccountId,
            },
            {
                providers: {
                    aws:
                        managementProvider,
                },
            },
        );
}


// -----------------------------------------------------------------------------
// Stage 2 - Bootstrap New Account
// -----------------------------------------------------------------------------
//
// Stage 2 uses the default AWS provider from ESC, which should assume the
// target account's OrganizationAccountAccessRole.
// -----------------------------------------------------------------------------

let bootstrapNewAccount:
    BootstrapNewAccount |
    undefined;

let bootstrapAccountId:
    string |
    undefined;

let bootstrapAccountName:
    string |
    undefined;

let bootstrapAccountAlias:
    string |
    undefined;

if (
    includesStage(
        "bootstrap_newaccount",
    )
) {
    bootstrapAccountId =
        config.require(
            "bootstrapAccountId",
        );

    bootstrapAccountName =
        config.require(
            "bootstrapAccountName",
        );

    bootstrapAccountAlias =
        config.get(
            "bootstrapAccountAlias",
        ) ??
        bootstrapAccountName;

    bootstrapNewAccount =
        new BootstrapNewAccount(
            "bootstrap-newaccount",
            {
                accountId:
                    bootstrapAccountId,

                accountName:
                    bootstrapAccountName,

                accountAlias:
                    bootstrapAccountAlias,
            },
            {
                dependsOn:
                    createNewAccount
                        ? [
                              createNewAccount,
                          ]
                        : [],
            },
        );
}


// -----------------------------------------------------------------------------
// Stage 3 - Target-account IAM Roles
// -----------------------------------------------------------------------------

let provisionIamRoles:
    ProvisionIamRoles |
    undefined;

let iamRolesAccountId:
    string |
    undefined;

let iamDepartment:
    string |
    undefined;

if (
    includesStage(
        "provision_iamroles",
    )
) {
    iamRolesAccountId =
        config.require(
            "iamRolesAccountId",
        );

    const iamIdentityAccountId =
        config.require(
            "IdentityAccountId",
        );

    const iamOrgAccountId =
        config.require(
            "OrgAccountId",
        );

    iamDepartment =
        config.require(
            "Department",
        );

    const iamStaticTags =
        config.getObject<
            Record<string, string>
        >(
            "iamStaticTags",
        ) ??
        config.getObject<
            Record<string, string>
        >(
            "staticTags",
        ) ??
        {};

    const restoreOrganizationAccountAccessRoleTrust =
        config.getBoolean(
            "iamRestoreOrganizationAccountAccessRoleTrust",
        ) ??
        true;

    const temporaryTrustPrincipalArn =
        config.get(
            "iamTemporaryTrustPrincipalArn",
        );

    const permanentTargetRoleArn =
        config.require(
            "iamPermanentTargetRoleArn",
        );

    const targetRoleArn =
        config.get(
            "iamTargetRoleArn",
        );

    const organizationAccountAccessRoleName =
        config.get(
            "iamOrganizationAccountAccessRoleName",
        ) ??
        "OrganizationAccountAccessRole";

    provisionIamRoles =
        new ProvisionIamRoles(
            "provision-iamroles",
            {
                accountId:
                    iamRolesAccountId,

                department:
                    iamDepartment,

                identityAccountId:
                    iamIdentityAccountId,

                orgAccountId:
                    iamOrgAccountId,

                staticTags:
                    iamStaticTags,

                targetRoleArn:
                    targetRoleArn,

                restoreOrganizationAccountAccessRoleTrust,

                temporaryTrustPrincipalArn,

                permanentTargetRoleArn,

                organizationAccountAccessRoleName,
            },
            {
                dependsOn:
                    bootstrapNewAccount
                        ? [
                              bootstrapNewAccount,
                          ]
                        : [],
            },
        );
}


// -----------------------------------------------------------------------------
// Stage 4 - Deploy VPC
// -----------------------------------------------------------------------------

let deployVpc:
    DeployVpc |
    undefined;

let vpcAccountId:
    string |
    undefined;

let vpcAccountName:
    string |
    undefined;

let vpcAccountAlias:
    string |
    undefined;

let vpcRegion:
    string |
    undefined;

let vpcEnvironment:
    string |
    undefined;

let vpcCidr:
    string |
    undefined;

const vpcRequired =
    config.getBoolean(
        "vpcRequired",
    ) ??
    true;

if (
    includesStage(
        "deploy_vpc",
    ) &&
    vpcRequired
) {
    vpcAccountId =
        config.require(
            "AccountId",
        );

    vpcAccountName =
        config.require(
            "AccountName",
        );

    vpcAccountAlias =
        config.get(
            "AccountAlias",
        ) ??
        vpcAccountName;

    vpcEnvironment =
        config.require(
            "Environment",
        );

    vpcRegion =
        config.require(
            "vpcRegion",
        );

    vpcCidr =
        config.require(
            "vpcCidr",
        );

    const vpcRegionPrefix =
        config.get(
            "vpcRegionPrefix",
        );

    const vpcConfig =
        config.requireObject<{
            min: number;
            max: number;
            enableDnsSupport: boolean;
            enableDnsHostnames: boolean;
        }>(
            "vpc",
        );

    const dhcpOptionsSet =
        config.requireObject<{
            domainName: string;
            domainNameServers: string[];
        }>(
            "dhcp_options_set",
        );

    const vpcStaticTags =
        config.getObject<
            Record<string, string>
        >(
            "vpcStaticTags",
        ) ??
        config.getObject<
            Record<string, string>
        >(
            "staticTags",
        ) ??
        {};

    const regionPrefixMap =
        config.getObject<
            Record<string, string>
        >(
            "regionPrefixMap",
        );

    deployVpc =
        new DeployVpc(
            "deploy-vpc",
            {
                accountId:
                    vpcAccountId,

                accountName:
                    vpcAccountName,

                accountAlias:
                    vpcAccountAlias,

                region:
                    vpcRegion,

                environment:
                    vpcEnvironment,

                vpcCidr:
                    vpcCidr,

                regionPrefix:
                    vpcRegionPrefix,

                vpcNumber:
                    vpcConfig.min,

                enableDnsSupport:
                    vpcConfig.enableDnsSupport,

                enableDnsHostnames:
                    vpcConfig.enableDnsHostnames,

                domainName:
                    dhcpOptionsSet.domainName,

                domainNameServers:
                    dhcpOptionsSet.domainNameServers,

                staticTags:
                    vpcStaticTags,

                regionPrefixMap:
                    regionPrefixMap,
            },
            {
                dependsOn:
                    provisionIamRoles
                        ? [
                              provisionIamRoles,
                          ]
                        : bootstrapNewAccount
                          ? [
                                bootstrapNewAccount,
                            ]
                          : [],
            },
        );
}


// -----------------------------------------------------------------------------
// Stage 5 - Configure Cloud Logging
// -----------------------------------------------------------------------------

let configureCloudLogging:
    ConfigureCloudLogging |
    undefined;

let cloudLoggingAccountId:
    string |
    undefined;

let cloudLoggingAccountName:
    string |
    undefined;

if (
    includesStage(
        "configure_cloudlogging",
    )
) {
    cloudLoggingAccountId =
        config.require(
            "AccountId",
        );

    cloudLoggingAccountName =
        config.require(
            "AccountName",
        );

    const cloudLoggingAccountAlias =
        config.get(
            "AccountAlias",
        ) ??
        cloudLoggingAccountName;

    const cloudLoggingRegion =
        config.require(
            "cloudLoggingRegion",
        );

    const cloudLoggingRegionPrefix =
        config.get(
            "cloudLoggingRegionPrefix",
        );

    const cloudLoggingEnvironment =
        config.require(
            "Environment",
        );

    const cloudLoggingStaticTags =
        config.getObject<
            Record<string, string>
        >(
            "cloudLoggingStaticTags",
        ) ??
        config.getObject<
            Record<string, string>
        >(
            "staticTags",
        ) ??
        {};

    configureCloudLogging =
        new ConfigureCloudLogging(
            "configure-cloudlogging",
            {
                accountId:
                    cloudLoggingAccountId,

                accountName:
                    cloudLoggingAccountName,

                accountAlias:
                    cloudLoggingAccountAlias,

                region:
                    cloudLoggingRegion,

                environment:
                    cloudLoggingEnvironment,

                regionPrefix:
                    cloudLoggingRegionPrefix,

                staticTags:
                    cloudLoggingStaticTags,
            },
            {
                dependsOn:
                    deployVpc
                        ? [
                              deployVpc,
                          ]
                        : provisionIamRoles
                          ? [
                                provisionIamRoles,
                            ]
                          : bootstrapNewAccount
                            ? [
                                  bootstrapNewAccount,
                              ]
                            : [],
            },
        );
}


// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

export const stage1_create_newaccount =
    createNewAccount
        ? {
              account_name:
                  createNewAccount.accountName,

              account_dl:
                  createNewAccount.accountDl,

              account_alias:
                  createNewAccount.accountAlias,

              decision:
                  createNewAccount.decision,

              actions_taken:
                  createNewAccount.actionsTaken,

              account_id:
                  createNewAccount.accountId,

              reason:
                  createNewAccount.reason,

              duplicate:
                  createNewAccount.duplicate,

              dry_run:
                  createNewAccount.dryRun,
          }
        : {
              status:
                  "not_enabled",
          };

export const stage2_bootstrap_newaccount =
    bootstrapNewAccount
        ? {
              account_id:
                  bootstrapNewAccount.accountId,

              account_name:
                  bootstrapNewAccount.accountName,

              account_alias:
                  bootstrapNewAccount.accountAlias,

              actions_taken:
                  bootstrapNewAccount.actionsTaken,

              warnings:
                  bootstrapNewAccount.warnings,

              dry_run:
                  bootstrapNewAccount.dryRun,
          }
        : {
              status:
                  "not_enabled",
          };

export const stage3_iam_roles =
    provisionIamRoles
        ? {
              account_id:
                  iamRolesAccountId,

              department:
                  iamDepartment,

              role_names:
                  provisionIamRoles.roleNames,

              trust_restore_status:
                  provisionIamRoles.restoreTrustStatus,
          }
        : {
              status:
                  "not_enabled",
          };

export const stage4_deploy_vpc =
    deployVpc
        ? {
              account_id:
                  vpcAccountId,

              account_name:
                  vpcAccountName,

              account_alias:
                  vpcAccountAlias,

              region:
                  vpcRegion,

              environment:
                  vpcEnvironment,

              vpc_cidr:
                  vpcCidr,

              vpc_name:
                  deployVpc.vpcName,

              vpc_id:
                  deployVpc.vpcId,

              igw_name:
                  deployVpc.igwName,

              igw_id:
                  deployVpc.igwId,

              dos_name:
                  deployVpc.dosName,

              dos_id:
                  deployVpc.dosId,

              public_route_table_name:
                  deployVpc.publicRouteTableName,

              public_route_table_id:
                  deployVpc.publicRouteTableId,

              private_route_table_name:
                  deployVpc.privateRouteTableName,

              private_route_table_id:
                  deployVpc.privateRouteTableId,

              subnet_count:
                  deployVpc.subnetCount,

              subnets:
                  deployVpc.subnets,

              common_tags:
                  deployVpc.commonTags,

              resource_tags:
                  deployVpc.resourceTags,
          }
        : includesStage(
              "deploy_vpc",
          ) &&
          !vpcRequired
          ? {
                status:
                    "not_required",
            }
          : {
                status:
                    "not_enabled",
            };

export const stage5_cloud_logging =
    configureCloudLogging
        ? {
              account_id:
                  configureCloudLogging.accountId,

              account_name:
                  configureCloudLogging.accountName,

              region:
                  configureCloudLogging.region,

              region_prefix:
                  configureCloudLogging.regionPrefix,

              cloudtrail_names:
                  configureCloudLogging.cloudTrailNames,

              cloudtrail_arns:
                  configureCloudLogging.cloudTrailArns,

              cloudwatch_log_group_names:
                  configureCloudLogging.cloudWatchLogGroupNames,

              cloudwatch_log_group_arns:
                  configureCloudLogging.cloudWatchLogGroupArns,

              kms_key_arn:
                  configureCloudLogging.kmsKeyArn,

              kms_alias:
                  configureCloudLogging.kmsKeyAlias,

              cloudtrail_cloudwatch_role_arn:
                  configureCloudLogging.cloudTrailCloudWatchLogsRoleArn,
          }
        : {
              status:
                  "not_enabled",
          };

export const deployment_stage =
    deployStage;

export const deployed_through_stage =
    deployedThroughStage ??
    deployStage;

export const effective_desired_state_stage =
    effectiveStage;

export const managed_stages =
    validStages.filter(
        (stage) =>
            stageRank[stage] <=
            effectiveStageRank,
    );