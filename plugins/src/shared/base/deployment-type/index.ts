import { BasePlugin } from '../../base-plugin.js';
import { PluginType, type PluginResponse } from '../../types.js';
import type {
  ComposeDeploymentParams,
  ComposeDeploymentResult,
  DescribeDeploymentTypeResult,
  ICallProductsDeploymentTypePlugin,
  IDeploymentTypePlugin,
  PrepareDeploymentParams,
  PrepareDeploymentResult,
  ValidateDeploymentParams,
  ValidateDeploymentResult,
} from './types.js';

export abstract class DeploymentTypePlugin
  extends BasePlugin<PluginType.DEPLOYMENT_TYPE>
  implements IDeploymentTypePlugin
{
  public readonly type = PluginType.DEPLOYMENT_TYPE as const;

  abstract describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>>;
  abstract prepareDeployment(
    options: PrepareDeploymentParams,
  ): Promise<PluginResponse<PrepareDeploymentResult>>;
  abstract validateDeployment(
    options: ValidateDeploymentParams,
  ): Promise<PluginResponse<ValidateDeploymentResult>>;
}

// The call-products contract is a separate base class rather than a weakening
// of DeploymentTypePlugin: existing CREATE2 authors keep their required
// prepare/validate methods, and a two-method call-products plugin builds
// without dummy implementations.
export abstract class CallProductsDeploymentTypePlugin
  extends BasePlugin<PluginType.DEPLOYMENT_TYPE>
  implements ICallProductsDeploymentTypePlugin
{
  public readonly type = PluginType.DEPLOYMENT_TYPE as const;

  abstract describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>>;
  abstract composeDeployment(
    options: ComposeDeploymentParams,
  ): Promise<PluginResponse<ComposeDeploymentResult>>;
}

export type {
  CallProductsDeploymentTypeOperations,
  ComposeDeploymentParams,
  ComposeDeploymentResult,
  DeploymentComposerField,
  DeploymentTypeExecution,
  DeploymentTypeOperations,
  DeploymentTypeParamField,
  DescribeDeploymentTypeResult,
  ICallProductsDeploymentTypePlugin,
  IDeploymentTypePlugin,
  PrepareDeploymentParams,
  PrepareDeploymentResult,
  ProducedCallComposition,
  ValidateDeploymentParams,
  ValidateDeploymentResult,
} from './types.js';
