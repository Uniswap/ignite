// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import AbiArgField, { DEAD_ADDRESS, signerFillChoices } from '../AbiArgField';

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

const ADDRESS = '0x1111111111111111111111111111111111111111';
const etherscanOption = {
  chainId: 1,
  key: '1:https://etherscan.io',
  label: 'Ethereum - Etherscan',
  addressUrlBase: 'https://etherscan.io',
};
const basescanOption = {
  chainId: 8453,
  key: '8453:https://basescan.org',
  label: 'Base - Basescan',
  addressUrlBase: 'https://basescan.org',
};

describe('AbiArgField explorer lookup', () => {
  it('opens the single available explorer directly', () => {
    const field = create(
      <AbiArgField
        input={{ name: 'owner', type: 'address' }}
        fieldKey="owner"
        value={ADDRESS}
        eligibleSteps={[]}
        explorerOptions={[etherscanOption]}
        onChange={() => {}}
      />
    );
    const link = field.root.findByProps({
      'aria-label': 'Open address in Ethereum - Etherscan',
    });
    expect(link.props.href).toBe(`https://etherscan.io/address/${ADDRESS}`);
    expect(link.props.target).toBe('_blank');
  });

  it('offers a picker instead of a direct link for several explorers', () => {
    const field = create(
      <AbiArgField
        input={{ name: 'owner', type: 'address' }}
        fieldKey="owner"
        value={ADDRESS}
        eligibleSteps={[]}
        explorerOptions={[etherscanOption, basescanOption]}
        onChange={() => {}}
      />
    );
    // Opening the Floating UI menu needs a DOM, which this suite runs
    // without; the trigger existing (and no direct link) is the contract.
    field.root.findByProps({
      'aria-label': 'Open address in a block explorer',
    });
    expect(field.root.findAllByType('a')).toHaveLength(0);
  });

  it('shows no explorer action for an incomplete address', () => {
    const field = create(
      <AbiArgField
        input={{ name: 'owner', type: 'address' }}
        fieldKey="owner"
        value="0x1111"
        eligibleSteps={[]}
        explorerOptions={[etherscanOption]}
        onChange={() => {}}
      />
    );
    expect(field.root.findAllByType('a')).toHaveLength(0);
  });
});

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

describe('AbiArgField dead address fill', () => {
  const deadButton = (signerOptions: (typeof ethereumSigner)[]) => {
    const onChange = vi.fn();
    const field = create(
      <AbiArgField
        input={{ name: 'owner', type: 'address' }}
        fieldKey="owner"
        value=""
        eligibleSteps={[]}
        signerOptions={signerOptions}
        onChange={onChange}
      />
    );
    return {
      onChange,
      button: field.root.findByProps({
        'aria-label': 'Fill with the dead address',
      }),
    };
  };

  it('fills the checksummed burn address', () => {
    const { onChange, button } = deadButton([ethereumSigner]);

    act(() => button.props.onClick());

    expect(button.children.join('')).toBe('Use dead address');
    // Spelled out, not `DEAD_ADDRESS`: the EIP-55 casing is the point, and a
    // typo in the constant would otherwise satisfy its own assertion.
    expect(onChange).toHaveBeenCalledWith(
      '0x000000000000000000000000000000000000dEaD'
    );
  });

  // The signer fill hides itself when no signer resolves for the step; the
  // dead address is a constant, so it must stay reachable regardless.
  it('stays available when no signer resolves', () => {
    const { onChange, button } = deadButton([]);

    act(() => button.props.onClick());

    expect(onChange).toHaveBeenCalledWith(DEAD_ADDRESS);
  });
});
