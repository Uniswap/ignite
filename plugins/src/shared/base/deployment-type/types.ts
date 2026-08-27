import { PluginType } from '../../types.js';
import type { PluginResponse } from '../../types.js';
import type { NoParams } from '../../index.js';

// Deliberately mirrors the select option vocabulary of PluginConfigField.
export interface DeploymentTypeParamField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  description?: string;
}

// How a deployment type actually deploys. Omitting `execution` normalizes to
// 'create2' so descriptors published before this discriminator stay valid.
export type DeploymentTypeExecution = 'create2' | 'call-products';

export interface DescribeDeploymentTypeResult {
  label: string;
  description: string;
  execution?: DeploymentTypeExecution;
  params: DeploymentTypeParamField[];
}

export interface PrepareDeploymentParams {
  chainId: number;
  initcode: string;
  runtimeBytecode?: string;
  proxyAddress: string;
  params?: Record<string, unknown>;
}

export interface PrepareDeploymentResult {
  salt: string;
  predictedAddress: string;
  notes?: string[];
}

export interface ValidateDeploymentParams {
  chainId: number;
  initcode: string;
  runtimeBytecode?: string;
  salt: string;
  predictedAddress: string;
  params?: Record<string, unknown>;
}

export interface ValidateDeploymentResult {
  ok: boolean;
  reason?: string;
}

export type DeploymentTypeOperations = {
  describeDeploymentType: { params: NoParams; result: DescribeDeploymentTypeResult };
  prepareDeployment: { params: PrepareDeploymentParams; result: PrepareDeploymentResult };
  validateDeployment: { params: ValidateDeploymentParams; result: ValidateDeploymentResult };
};

export type IDeploymentTypePlugin = {
  type: PluginType.DEPLOYMENT_TYPE;
} & {
  [K in keyof DeploymentTypeOperations]: (
    options: DeploymentTypeOperations[K]['params'],
  ) => Promise<PluginResponse<DeploymentTypeOperations[K]['result']>>;
};

// --- call-products execution mode ---
// A call-products plugin composes one producer call plus its products at
// authoring time. The host validates, materializes, simulates, persists,
// signs, broadcasts, and reconciles; the plugin never encodes calldata,
// touches an RPC, or supplies authoritative runtime addresses.

// The deliberately small dynamic-form vocabulary the host renders for a
// composition. Plugins cannot provide markup, component names, executable
// frontend code, or arbitrary validation expressions.
//
// The host rejects a compose response that breaks any of its bounds WHOLE, so
// a plugin must respect them itself and degrade — omit what it cannot express
// and say so, or return a `blocker` — rather than emit an over-cap response:
//   fields          at most 32, unique keys
//   key             /^[a-zA-Z][a-zA-Z0-9._-]*$/, at most 64 characters
//   label           1..280 characters (description likewise)
//   select options  1..64, unique values, each value 1..280 characters and
//                   free of control characters
//   products        1..16, unique keys and unique outputIndexes, each key
//                   subject to the same key rules as a field key
//   blocker         1..500 characters, and never alongside a composition
// Values the host hands IN are bounded too, so echoing one back cannot on its
// own overflow a cap above: each entry of `values` is at most 512 characters
// (the whole record at most 64 KiB), and `config` is a reserved key that never
// appears there.
export type DeploymentComposerField =
  | {
      type: 'artifact';
      key: string;
      label: string;
      description?: string;
      required?: boolean;
      origins?: Array<'repo' | 'contract-type'>;
    }
  | {
      type: 'address';
      key: string;
      label: string;
      description?: string;
      required?: boolean;
    }
  | {
      type: 'select';
      key: string;
      label: string;
      description?: string;
      required?: boolean;
      options: Array<{ value: string; label: string }>;
    };

export interface ComposeDeploymentParams {
  compositionId: string;
  values: Record<string, unknown>;
  // A bounded view of only the ABIs the user explicitly selected — never
  // bytecode, repository contents, RPC URLs, or secrets.
  artifacts: Record<
    string,
    {
      selectionId: string;
      contractName: string;
      abi: unknown;
    }
  >;
}

export interface ProducedCallComposition {
  producer: {
    abiArtifactField: string;
    targetField: string;
    // Names a select field whose value is a canonical input-only function
    // signature (e.g. `deploy(bytes32,(address,uint256))`). Core resolves it
    // against the authoritative selected ABI; the plugin never supplies the
    // executable ABI function or final call signature.
    functionField: string;
  };
  products: Array<{
    key: string;
    artifactField: string;
    outputIndex: number;
    params?: Record<string, unknown>;
  }>;
}

export interface ComposeDeploymentResult {
  fields: DeploymentComposerField[];
  blocker?: string;
  composition?: ProducedCallComposition;
}

export type CallProductsDeploymentTypeOperations = {
  describeDeploymentType: { params: NoParams; result: DescribeDeploymentTypeResult };
  composeDeployment: { params: ComposeDeploymentParams; result: ComposeDeploymentResult };
};

export type ICallProductsDeploymentTypePlugin = {
  type: PluginType.DEPLOYMENT_TYPE;
} & {
  [K in keyof CallProductsDeploymentTypeOperations]: (
    options: CallProductsDeploymentTypeOperations[K]['params'],
  ) => Promise<PluginResponse<CallProductsDeploymentTypeOperations[K]['result']>>;
};
