// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { keccak256, stringToHex } from 'viem';
import ValidationChecklist, { artifactDrifts, signatureFallback } from '../ValidationChecklist';

const driftItem = {
  ok: false,
  blocking: true,
  code: 'WORKFLOW_ARTIFACT_DRIFT',
  message: 'Frozen artifact hashes differ',
  details: {
    drifts: [
      { sourceId: 'token', expected: 'a'.repeat(64), actual: 'b'.repeat(64) },
    ],
  },
};

describe('workflow validation checklist', () => {
  it('extracts typed artifact drift acknowledgements from failure details', () => {
    expect(artifactDrifts(driftItem)).toEqual([
      { sourceId: 'token', expected: 'a'.repeat(64), actual: 'b'.repeat(64) },
    ]);
  });

  it('renders run-level workflow/output items and the inline drift action', () => {
    const html = renderToStaticMarkup(
      <ValidationChecklist
        chains={{}}
        chainInfo={[]}
        run={{
          workflow: { ok: true, blocking: true, message: 'Workflow bound' },
          outputs: { ok: false, blocking: false, message: 'Hook unavailable' },
        }}
        onAcceptArtifactDrift={() => undefined}
      />
    );
    expect(html).toContain('Workflow bound');
    expect(html).toContain('Hook unavailable');
    const driftHtml = renderToStaticMarkup(
      <ValidationChecklist
        chains={{
          '1': {
            rpc: driftItem,
            signers: driftItem,
            args: driftItem,
            estimation: driftItem,
            balance: driftItem,
            inputs: driftItem,
          },
        }}
        chainInfo={[]}
        onAcceptArtifactDrift={() => undefined}
      />
    );
    expect(driftHtml).toContain('Accept drifted bytecode');
  });

  it('renders collapsed per-step events and on-demand storage controls', () => {
    const item = {
      ok: true,
      blocking: false,
      message: 'Simulation completed',
      details: {
        tier: 'fork',
        perStep: { deploy: { status: 'reverted', reason: 'constructor reverted', gasUsed: '42' } },
      },
    };
    const html = renderToStaticMarkup(
      <ValidationChecklist
        chains={{
          '1': { rpc: item, signers: item, args: item, estimation: item, balance: item, inputs: item, simulation: item },
        }}
        chainInfo={[]}
        plan={{ schemaVersion: 1, contracts: [], steps: [], chains: [1], signers: {} }}
        rpcSelection={{ '1': 'rpc' }}
      />
    );
    expect(html).toContain('Events');
    expect(html).toContain('Events need a simulating tier.');
    expect(html).toContain('Get storage slot changes');
    expect(html).toContain('Status: reverted');
    expect(html).toContain('constructor reverted');
  });

  it('hides storage replay for estimate and skipped steps and keeps legacy gas details', () => {
    const item = {
      ok: true,
      blocking: false,
      message: 'Simulation completed',
      details: { tier: 'estimate', gasByStep: { deploy: '42' } },
    };
    const html = renderToStaticMarkup(
      <ValidationChecklist
        chains={{ '1': { rpc: item, signers: item, args: item, estimation: item, balance: item, inputs: item, simulation: item } }}
        chainInfo={[]}
        plan={{ schemaVersion: 1, contracts: [], steps: [], chains: [1], signers: {} }}
        rpcSelection={{ '1': 'rpc' }}
      />,
    );
    expect(html).not.toContain('Get storage slot changes');
    expect(html).toContain('42');
    const skippedItem = { ...item, details: { tier: 'fork', perStep: { skipped: { status: 'skipped-existing' } } } };
    const skipped = renderToStaticMarkup(
      <ValidationChecklist
        chains={{ '1': { rpc: skippedItem, signers: item, args: item, estimation: item, balance: item, inputs: item, simulation: skippedItem } }}
        chainInfo={[]}
        plan={{ schemaVersion: 1, contracts: [], steps: [], chains: [1], signers: {} }}
        rpcSelection={{ '1': 'rpc' }}
      />,
    );
    expect(skipped).not.toContain('Get storage slot changes');
  });

  it('uses the emitting contract ABI before scanning other colliding ABIs', () => {
    const address = `0x${'12'.repeat(20)}`;
    const sender = `0x${'34'.repeat(20)}`;
    const topic0 = keccak256(stringToHex('Log(address,uint256)'));
    const item = {
      ok: true,
      blocking: false,
      message: 'Simulation completed',
      details: {
        tier: 'fork',
        perStep: { deploy: { status: 'ok', logs: [{ address, topics: [topic0, `0x${'0'.repeat(24)}${sender.slice(2)}`], data: `0x${'0'.repeat(63)}7` }] } },
      },
    };
    const create2 = { ...item, details: { predicted: { deploy: { predictedAddress: address } } } };
    const html = renderToStaticMarkup(
      <ValidationChecklist
        chains={{ '1': { rpc: item, signers: item, args: item, estimation: item, balance: item, inputs: item, simulation: item, create2 } }}
        chainInfo={[]}
        plan={{ schemaVersion: 1, contracts: [{ id: 'right', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'a', contractName: 'Right', sourcePath: 'Right.sol' }], steps: [{ id: 'deploy', kind: 'deploy', contractId: 'right' }], chains: [1], signers: {} }}
        frozenInputs={{
          wrong: { abi: [{ type: 'event', name: 'Log', inputs: [{ name: 'recipient', type: 'address', indexed: false }, { name: 'amount', type: 'uint256', indexed: true }] }], creationBytecode: '0x', compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) }, artifactHash: 'a'.repeat(64), repoDirty: false },
          right: { abi: [{ type: 'event', name: 'Log', inputs: [{ name: 'sender', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] }], creationBytecode: '0x', compiler: { pluginId: 'f', version: '1', settingsHash: 'b'.repeat(64) }, artifactHash: 'b'.repeat(64), repoDirty: false },
        }}
      />,
    );
    expect(html).toContain(`sender: ${sender}`);
    expect(html).not.toContain('recipient:');
  });

  it('keeps 4byte signatures as labels with raw topics and data', () => {
    expect(signatureFallback('Log(address,uint256)', {
      address: `0x${'12'.repeat(20)}`,
      topics: [`0x${'34'.repeat(32)}`],
      data: '0x1234',
    })).toEqual({
      label: 'Log(address,uint256)',
      raw: `topics: 0x${'34'.repeat(32)}\ndata: 0x1234`,
    });
  });
});
