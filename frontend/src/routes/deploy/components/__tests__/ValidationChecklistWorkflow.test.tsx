// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ValidationChecklist, { artifactDrifts } from '../ValidationChecklist';

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
        tier: 'estimate',
        perStep: { deploy: { status: 'ok', gasUsed: '42' } },
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
  });
});
