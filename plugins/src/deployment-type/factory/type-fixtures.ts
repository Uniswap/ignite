// Compile-time-only fixtures for the deployment-type SDK contract: a minimal
// three-method CREATE2 plugin and a minimal two-method call-products plugin
// must both build against the runPluginCLI generics independently, without
// dummy methods from the other family. This file is type-checked by this
// package's `tsc --noEmit`; index.ts never imports it, so esbuild does not
// bundle it and nothing here executes.
import {
  CallProductsDeploymentTypePlugin,
  DeploymentTypePlugin,
  type CallProductsDeploymentTypeOperations,
  type ComposeDeploymentResult,
  type DeploymentTypeOperations,
  type DescribeDeploymentTypeResult,
  type PluginResponse,
  type PrepareDeploymentResult,
  type ValidateDeploymentResult,
} from '../../shared/index.ts';
import { runPluginCLI } from '../../shared/plugin-runner.js';

class MinimalCreate2 extends DeploymentTypePlugin {
  async describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>> {
    return { success: true, data: { label: 'Minimal CREATE2', description: 'Compile-time fixture.', params: [] } };
  }
  async prepareDeployment(): Promise<PluginResponse<PrepareDeploymentResult>> {
    return {
      success: true,
      data: {
        salt: '0x0000000000000000000000000000000000000000000000000000000000000000',
        predictedAddress: '0x0000000000000000000000000000000000000000',
      },
    };
  }
  async validateDeployment(): Promise<PluginResponse<ValidateDeploymentResult>> {
    return { success: true, data: { ok: true } };
  }
}

class MinimalCallProducts extends CallProductsDeploymentTypePlugin {
  async describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>> {
    return {
      success: true,
      data: { label: 'Minimal call-products', description: 'Compile-time fixture.', execution: 'call-products', params: [] },
    };
  }
  async composeDeployment(): Promise<PluginResponse<ComposeDeploymentResult>> {
    return { success: true, data: { fields: [] } };
  }
}

// Never called: the point is that each runner invocation type-checks against
// its own operation family's key set.
export function assertRunnerFamiliesCompile(): void {
  void runPluginCLI<keyof DeploymentTypeOperations>(new MinimalCreate2());
  void runPluginCLI<keyof CallProductsDeploymentTypeOperations>(new MinimalCallProducts());
}
