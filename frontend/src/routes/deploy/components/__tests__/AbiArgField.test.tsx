// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import AbiArgField, { signerFillChoices } from '../AbiArgField';

const ethereumSigner = {
  chainId: 1,
  chainLabel: 'Ethereum',
  address: '0xde82000000000000000000000000000000002e97',
};
const baseSigner = {
  chainId: 8453,
  chainLabel: 'Base',
  address: '0x123400000000000000000000000000000000abcd',
};

describe('AbiArgField signer fill', () => {
  it('deduplicates one signer used on several chains', () => {
    expect(
      signerFillChoices([
        ethereumSigner,
        { ...ethereumSigner, chainId: 8453, chainLabel: 'Base' },
      ])
    ).toEqual([
      {
        address: ethereumSigner.address,
        label: 'Ethereum, Base · 0xde82…2e97',
      },
    ]);
  });

  it('fills a literal address with one click for a single effective signer', () => {
    const onChange = vi.fn();
    const field = create(
      <AbiArgField
        input={{ name: 'owner', type: 'address' }}
        fieldKey="owner"
        value=""
        eligibleSteps={[]}
        signerOptions={[ethereumSigner]}
        onChange={onChange}
      />
    );

    const button = field.root.findByProps({
      'aria-label': 'Fill from effective signer',
    });
    act(() => button.props.onClick());

    expect(button.children.join('')).toBe('Use signer 0xde82…2e97');
    expect(onChange).toHaveBeenCalledWith(ethereumSigner.address);
  });

  it('offers each effective address when signers differ by chain', () => {
    const onChange = vi.fn();
    const field = create(
      <AbiArgField
        input={{ name: 'owner', type: 'address' }}
        fieldKey="owner"
        value=""
        eligibleSteps={[]}
        signerOptions={[ethereumSigner, baseSigner]}
        onChange={onChange}
      />
    );
    const select = field.root.findByProps({
      'aria-label': 'Fill from effective signer',
    });

    act(() => select.props.onChange({ target: { value: baseSigner.address } }));

    expect(
      select.findAllByType('option').map((option) => option.children.join(''))
    ).toEqual(['Use signer…', 'Ethereum · 0xde82…2e97', 'Base · 0x1234…abcd']);
    expect(onChange).toHaveBeenCalledWith(baseSigner.address);
  });
});
