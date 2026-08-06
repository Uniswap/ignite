// Shared rendering for a pinned repository version chip.
//
// Two vocabularies meet here: a draft/workflow pin carries an optional `ref`
// (ContractSourcePin), while the server's version record carries the label as
// `refLabel` (RepoVersionSummary). Reading only one of them is why the wizard
// lost the tag while the repository page kept it, so the label is resolved from
// the record first and the pin second.
//
// The chip must never print the commit twice: the previous call sites rendered
// `label ?? shortCommit` followed by the short commit, so an unlabelled pin
// showed `3cbfd28e76c5 · 3cbfd28e76c5`.

const SHORT_COMMIT_CHARS = 12;

export interface DisplayPin {
  url: string;
  commit: string;
  ref?: string;
}

export interface DisplayVersion {
  url: string;
  commit: string;
  refLabel?: string;
}

// Structural view of the repositories slice: only the version-bearing shapes
// matter, so callers can pass the slice straight through.
export interface DisplayRepositories {
  local?: Array<{ versions?: DisplayVersion[] }>;
  cloned?: Array<{ versions?: DisplayVersion[] }>;
  session?: { versions?: DisplayVersion[] } | null;
  versionGroups?: Array<{ url?: string; versions?: DisplayVersion[] }>;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_CHARS);
}

function cleaned(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/// The label to show next to the commit, or undefined when only a commit is
/// known. A label equal to the commit is treated as absent so it cannot be
/// rendered twice.
export function pinVersionLabel(
  pin: DisplayPin | undefined,
  version?: DisplayVersion
): string | undefined {
  if (!pin) return undefined;
  const label = cleaned(version?.refLabel) ?? cleaned(pin.ref);
  if (!label) return undefined;
  return label === pin.commit || label === shortCommit(pin.commit)
    ? undefined
    : label;
}

/// `label · commit` when a label is known, otherwise the bare short commit.
export function pinChipText(pin: DisplayPin, version?: DisplayVersion): string {
  const short = shortCommit(pin.commit);
  const label = pinVersionLabel(pin, version);
  return label ? `${label} · ${short}` : short;
}

/// Finds the server's record for a pin across every place versions are held.
/// Absorbs the lookup previously open-coded in ArtifactPicker.
export function findVersionForPin(
  // The repositories slice holds `RepoList | null` before its first load.
  repositories: DisplayRepositories | null | undefined,
  pin: DisplayPin | undefined
): DisplayVersion | undefined {
  if (!repositories || !pin) return undefined;
  const candidates = [
    ...(repositories.versionGroups ?? []).flatMap(
      (group) => group.versions ?? []
    ),
    ...(repositories.local ?? []).flatMap((entry) => entry.versions ?? []),
    ...(repositories.cloned ?? []).flatMap((entry) => entry.versions ?? []),
    ...(repositories.session?.versions ?? []),
  ];
  return candidates.find(
    (version) => version.url === pin.url && version.commit === pin.commit
  );
}
