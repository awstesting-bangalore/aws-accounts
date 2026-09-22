import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { CreateNewAccount } from "@awstesting-bangalore/create-newaccount";
import { BootstrapNewAccount } from "@awstesting-bangalore/bootstrap-newaccount";
// Stages 3-5 (provision_iamroles, deploy_vpc, configure_cloudlogging) do not
// have provider packages implemented yet. Their imports and instantiation
// are intentionally omitted below; the corresponding stages fail fast with
// a clear error until they are built.


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

let bootstrapNewAccount:
    BootstrapNewAccount |
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

    const managementBootstrapRoleArn =
        config.require(
            "managementBootstrapRoleArn",
        );

    const memberAccountRoleName =
        config.require(
            "memberAccountRoleName",
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
                
                checkAccountNames:
                    checkAccountNames,

                allowedPrefix:
                    allowedPrefix,

                forbiddenPrefixes:
                    forbiddenPrefixes,
                
                managedAccountId:
                    managedAccountId,

                managementAccountRoleArn:
                    managementAccountRoleArn,

                managementBootstrapRoleArn:
                    managementBootstrapRoleArn,

                memberAccountRoleName:
                    memberAccountRoleName,
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
// Stage 2 targets the member account directly, via an explicit provider that
// assumes OrganizationAccountAccessRole in that account. The target account
// id/name/alias are supplied explicitly (mirroring managedAccountId in Stage
// 1) rather than derived from the Stage 1 resource, since Stage 2 can also
// run as part of a later, IAM-only reconciliation pass.
// -----------------------------------------------------------------------------

if (
    includesStage(
        "bootstrap_newaccount",
    )
) {
    const bootstrapAccountId =
        config.require(
            "bootstrapAccountId",
        );

    const bootstrapAccountName =
        config.get(
            "bootstrapAccountName",
        );

    const bootstrapAccountAlias =
        config.get(
            "bootstrapAccountAlias",
        );

    const targetAccountProvider =
        new aws.Provider(
            "target-account",
            {
                region:
                    "us-east-1",

                assumeRoles: [
                    {
                        roleArn:
                            pulumi.interpolate`arn:aws:iam::${bootstrapAccountId}:role/OrganizationAccountAccessRole`,

                        sessionName:
                            "pulumi-bootstrap-newaccount",
                    },
                ],
            },
        );

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
                providers: {
                    aws:
                        targetAccountProvider,
                },
            },
        );
}


// -----------------------------------------------------------------------------
// Stage 3 - Target-account IAM Roles
// -----------------------------------------------------------------------------

if (
    includesStage(
        "provision_iamroles",
    )
) {
    throw new Error(
        "Stage 3 (provision_iamroles) is not implemented yet: " +
        "no ProvisionIamRoles provider package exists.",
    );
}


// -----------------------------------------------------------------------------
// Stage 4 - Deploy VPC
// -----------------------------------------------------------------------------

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
    throw new Error(
        "Stage 4 (deploy_vpc) is not implemented yet: " +
        "no DeployVpc provider package exists.",
    );
}


// -----------------------------------------------------------------------------
// Stage 5 - Configure Cloud Logging
// -----------------------------------------------------------------------------

if (
    includesStage(
        "configure_cloudlogging",
    )
) {
    throw new Error(
        "Stage 5 (configure_cloudlogging) is not implemented yet: " +
        "no ConfigureCloudLogging provider package exists.",
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

// Stages 3-5 have no provider package implemented yet (see the stage guards
// above, which fail fast if one of these stages is actually requested), so
// their outputs are always "not_enabled" for now.
export const stage3_iam_roles =
    {
        status:
            "not_enabled",
    };

export const stage4_deploy_vpc =
    includesStage(
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
    {
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
