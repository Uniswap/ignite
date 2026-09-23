import type { ReactNode } from 'react';
import { useAppSelector } from '../../../store';

// Argument overrides render one field per selected chain, and the field itself
// only carries the argument name. The chain heading is what tells the user
// which deployment target a given override applies to, matching the cards the
// target, salt, library and transaction overrides already use.
export default function ChainOverrideCard({
  chainId,
  children,
}: {
  chainId: number;
  children: ReactNode;
}) {
  const chain = useAppSelector((state) =>
    state.chains.chains.find((item) => item.chainId === chainId)
  );
  return (
    <div className="card-milky p-3 grid gap-2">
      <span className="font-medium">
        {chain ? (
          <>
            {chain.name} <span className="mono-data text-muted">{chainId}</span>
          </>
        ) : (
          `Chain ${chainId}`
        )}
      </span>
      {children}
    </div>
  );
}
