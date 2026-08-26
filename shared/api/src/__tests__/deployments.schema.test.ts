import { describe, expect, it } from "vitest";
import {
  AttemptSchema,
  DeploymentPlanSchema,
  RunRecordSchema,
} from "../v1/deployments.js";
import { ComposeDeploymentRequestSchema } from "../v1/deploymentTypes.js";

const signer = {
  pluginId: "private-key",
  accountId: "account-1",
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
};

describe("deployment schemas", () => {
  it("round-trips a maximal plan with per-chain overrides", () => {
    const plan = {
      schemaVersion: 1,
      contracts: [
        {
          id: "token",
          repoPathOrUrl: "/repo",
          frameworkId: "foundry",
          artifactPath: "out/Token.sol/Token.json",
          contractName: "Token",
          sourcePath: "src/Token.sol",
        },
      ],
      steps: [
        {
          id: "deploy-token",
          kind: "deploy",
          contractId: "token",
          args: {
            name: "Token",
            supply: "1000",
            config: { owner: signer.address },
          },
          argsPerChain: {
            "1": { supply: "2000", config: { owner: signer.address } },
          },
          value: "0",
          valuePerChain: { "1": "42" },
          gasOverrides: { gasLimit: "100000", maxFeePerGas: "20" },
          gasOverridesPerChain: { "1": { maxPriorityFeePerGas: "2" } },
          signerOverride: {
            global: signer,
            perChain: { "1": { ...signer, accountId: "account-2" } },
          },
        },
      ],
      chains: [1],
      signers: { global: signer, perChain: { "1": signer } },
    };

    expect(DeploymentPlanSchema.parse(plan)).toEqual(plan);
  });

  it.each([
    [{ ...basePlan(), steps: [{ ...basePlan().steps[0], kind: "call" }] }],
    [{ ...basePlan(), steps: [{ ...basePlan().steps[0], value: "1.5" }] }],
    [{ ...basePlan(), signers: { perChain: { mainnet: signer } } }],
  ])("rejects invalid plan input", (plan: unknown) => {
    expect(() => DeploymentPlanSchema.parse(plan)).toThrow();
  });

  it("rejects unknown run-record schema versions", () => {
    expect(() =>
      RunRecordSchema.parse({
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it.each([
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, contracts: [] }),
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, steps: [] }),
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, chains: [] }),
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, contracts: [...plan.contracts, { ...plan.contracts[0] }] }),
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, steps: [...plan.steps, { ...plan.steps[0] }] }),
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, chains: [1, 1] }),
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, steps: [{ ...plan.steps[0], contractId: 'missing' }] }),
    (plan: ReturnType<typeof basePlan>) => ({ ...plan, signers: { perChain: { '01': signer } } }),
  ])("enforces plan identity and chain-key invariants", (mutate) => {
    expect(() => DeploymentPlanSchema.parse(mutate(basePlan()))).toThrow();
  });

  it("allows raw transactions in persisted attempts", () => {
    expect(
      AttemptSchema.parse({
        id: "attempt-1",
        startedAt: "2026-07-10T12:00:00.000Z",
        rawTx: "0x02abcd",
      }),
    ).toMatchObject({ rawTx: "0x02abcd" });
  });
});

describe("compose deployment request schema", () => {
  const request = (values: Record<string, unknown>) => ({
    pluginId: "factory",
    compositionId: "comp-1",
    revision: 0,
    values,
    artifacts: {},
  });

  it("bounds each value on its own, not just the whole record", () => {
    // A plugin echoing a value into its 1..500-char blocker or a 1..280-char
    // label must not be able to overflow those caps with what the host handed
    // it, so the per-value cap belongs at the wire boundary.
    expect(
      ComposeDeploymentRequestSchema.safeParse(
        request({ fn: "x".repeat(513) }),
      ).success,
    ).toBe(false);
    expect(
      ComposeDeploymentRequestSchema.safeParse(request({ fn: "x".repeat(512) }))
        .success,
    ).toBe(true);
    // Non-string values are bounded by their serialized length.
    expect(
      ComposeDeploymentRequestSchema.safeParse(
        request({ fn: Array.from({ length: 200 }, (_, i) => i) }),
      ).success,
    ).toBe(false);
  });

  it("still accepts many legal values and still rejects the aggregate overflow", () => {
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `field${index}`,
        "x".repeat(512),
      ]),
    );
    expect(ComposeDeploymentRequestSchema.safeParse(request(many)).success).toBe(
      true,
    );
    const overflowing = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `field${index}`,
        "x".repeat(512),
      ]),
    );
    expect(
      ComposeDeploymentRequestSchema.safeParse(request(overflowing)).success,
    ).toBe(false);
    // The reserved plugin-invocation key stays rejected.
    expect(
      ComposeDeploymentRequestSchema.safeParse(request({ config: "x" })).success,
    ).toBe(false);
  });
});

function basePlan() {
  return {
    schemaVersion: 1 as const,
    contracts: [
      {
        id: "token",
        repoPathOrUrl: "/repo",
        frameworkId: "foundry",
        artifactPath: "out/Token.sol/Token.json",
        contractName: "Token",
        sourcePath: "src/Token.sol",
      },
    ],
    steps: [
      { id: "deploy-token", kind: "deploy" as const, contractId: "token" },
    ],
    chains: [1],
    signers: { global: signer },
  };
}
