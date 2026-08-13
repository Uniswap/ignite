import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { makeForkRunner, storageDiff, storageTraceTarget } from '../../deployments/forkContainer.js';

describe('fork container lifecycle', () => {
  it('normalizes prestate tracer storage diffs and retains touched accounts', () => {
    expect(storageDiff({
      pre: {
        '0x0000000000000000000000000000000000000001': {
          storage: { '0x1': '0x02' },
        },
      },
      post: {
        '0x0000000000000000000000000000000000000001': {
          storage: { '0x1': '0x03', '0x2': '0x04' },
        },
        '0x0000000000000000000000000000000000000002': {},
      },
    })).toEqual({
      '0x0000000000000000000000000000000000000001': [
        { slot: `0x${'0'.repeat(63)}1`, before: `0x${'0'.repeat(62)}02`, after: `0x${'0'.repeat(62)}03` },
        { slot: `0x${'0'.repeat(63)}2`, before: `0x${'0'.repeat(64)}`, after: `0x${'0'.repeat(62)}04` },
      ],
      '0x0000000000000000000000000000000000000002': [],
    });
  });

  it('prioritizes produced deploy addresses over the CREATE2 proxy for storage traces', () => {
    const produced = '0x0000000000000000000000000000000000000002' as const;
    expect(storageTraceTarget({ stepId: 'deploy', kind: 'tx', to: '0x0000000000000000000000000000000001', predictedAddress: produced })).toBe(produced);
    expect(storageTraceTarget({ stepId: 'deploy', kind: 'tx', to: '0x0000000000000000000000000000000001', address: produced, predictedAddress: '0x0000000000000000000000000000000003' })).toBe(produced);
    expect(storageTraceTarget({ stepId: 'create', kind: 'tx', to: null, address: produced })).toBe(produced);
    expect(storageTraceTarget({ stepId: 'call', kind: 'tx', to: '0x0000000000000000000000000000000001' })).toBe('0x0000000000000000000000000000000001');
  });

  it('does not pull a missing foundry image', async () => {
    const inspectImage = vi.fn(async () => {
      throw new Error('missing');
    });
    const createContainer = vi.fn();
    await expect(
      makeForkRunner(
        { rpcUrl: 'https://secret.example', chainId: 1 },
        {
          docker: {
            inspectImage,
            createContainer,
            getContainer: vi.fn(),
            listContainers: vi.fn(),
          } as never,
        }
      )
    ).resolves.toBeUndefined();
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('labels fork containers with their owner and removes a created husk when start fails', async () => {
    const remove = vi.fn(async () => undefined);
    const createContainer = vi.fn(async () => ({
      start: vi.fn(async () => {
        throw new Error('start failed');
      }),
      stop: vi.fn(async () => undefined),
      remove,
    }));

    await makeForkRunner(
      { rpcUrl: 'https://secret.example', chainId: 1, forkBlockNumber: 123 },
      {
        docker: {
          inspectImage: vi.fn(async () => undefined),
          createContainer,
          getContainer: vi.fn(),
        } as never,
      }
    );

    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: expect.objectContaining({
          'ignite-simfork': '1',
          'ignite.managed': 'true',
          'ignite.pid': String(process.pid),
          'ignite.host': os.hostname(),
        }),
        Cmd: [expect.stringContaining('--fork-block-number 123')],
      })
    );
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });
});
