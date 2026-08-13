import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Loader2, Save, X } from 'lucide-react';
import {
  WorkflowNamePattern,
  type DeploymentPlan,
  type WorkflowPromotionBookChoice,
  type WorkflowPromoteData,
  type WorkflowPromoteRequest,
} from '@ignite/api';
import { ApiError } from '@ignite/api/client';
import { apiClient } from '../store/api/client';
import { useAppDispatch, useAppSelector } from '../store';
import { triggerToast } from '../store/middleware/toastListener';
import { formatApiError } from '../store/middleware/apiGate';
import Select from './Select';
import ConfirmDialog from './ConfirmDialog';
import { getRepoName } from '../utils/repo';
import { decodeUrlEncodingForDisplay } from '../utils/displayText';

type PromotionInput = { plan: DeploymentPlan } | { runId: string };

export const promotionNameValid = (name: string) =>
  WorkflowNamePattern.test(name);

export function promotionPreviewRequest(
  repoPathOrUrl: string,
  name: string,
  input: PromotionInput
): WorkflowPromoteRequest {
  return { mode: 'preview', target: { repoPathOrUrl, name }, ...input };
}

export function promotionApplyRequest(
  repoPathOrUrl: string,
  name: string,
  input: PromotionInput,
  previewId: string,
  options: {
    hooks: string[];
    tagChoiceBySourceId?: Record<string, string>;
    overwrite?: boolean;
    adopt?: boolean;
    bookChoices?: Record<string, WorkflowPromotionBookChoice>;
  }
): WorkflowPromoteRequest {
  return {
    mode: 'apply',
    previewId,
    target: { repoPathOrUrl, name },
    ...input,
    hooks: options.hooks,
    ...(options.tagChoiceBySourceId &&
    Object.keys(options.tagChoiceBySourceId).length
      ? { tagChoiceBySourceId: options.tagChoiceBySourceId }
      : {}),
    ...(options.overwrite ? { overwrite: true } : {}),
    ...(options.bookChoices && Object.keys(options.bookChoices).length
      ? { bookChoices: options.bookChoices }
      : {}),
    ...('runId' in input && options.adopt
      ? { adoptRunIds: [input.runId] }
      : {}),
  };
}

export default function PromoteWorkflowDialog({
  open,
  onOpenChange,
  input,
  hooks,
  onPromoted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: PromotionInput;
  hooks: string[];
  onPromoted: (repoPathOrUrl: string, name: string) => void;
}) {
  const dispatch = useAppDispatch();
  const repositories = useAppSelector(
    (state) => state.repositories.repositories
  );
  const repoOptions = useMemo(
    () =>
      [...(repositories?.local ?? []), ...(repositories?.cloned ?? [])].map(
        (repo) => ({
          value: repo.pathOrUrl,
          label: `${getRepoName(repo.pathOrUrl)} · ${repo.pathOrUrl}`,
        })
      ),
    [repositories]
  );
  const [repoPathOrUrl, setRepoPathOrUrl] = useState<string>();
  const [name, setName] = useState('');
  const [preview, setPreview] =
    useState<Extract<WorkflowPromoteData, { mode: 'preview' }>>();
  const [tagChoices, setTagChoices] = useState<Record<string, string>>({});
  const [bookChoices, setBookChoices] = useState<
    Record<string, WorkflowPromotionBookChoice>
  >({});
  const [adopt, setAdopt] = useState('runId' in input);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [overwriteConfirm, setOverwriteConfirm] = useState(false);

  const resetPreview = () => {
    setPreview(undefined);
    setTagChoices({});
    setBookChoices({});
    setError(undefined);
  };
  const previewBlocked = !repoPathOrUrl || !promotionNameValid(name);
  const applyBlocked =
    !preview ||
    preview.sources.some(
      (source) =>
        source.error ||
        (source.tagChoices.length > 1 && !tagChoices[source.sourceId])
    ) ||
    preview.referencedEntries.some(
      (entry) => entry.conflict && !bookChoices[entry.name]
    );

  const requestPreview = async () => {
    if (!repoPathOrUrl || !promotionNameValid(name)) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await apiClient.request('promoteWorkflow', {
        body: promotionPreviewRequest(repoPathOrUrl, name, input),
      });
      if (!('data' in response) || response.data.mode !== 'preview')
        throw new Error('Invalid promotion preview response');
      setPreview(response.data);
      setBookChoices({});
      setTagChoices(
        Object.fromEntries(
          response.data.sources.flatMap((source) =>
            source.tagChoices.length === 1
              ? [[source.sourceId, source.tagChoices[0]]]
              : []
          )
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const apply = async (overwrite = false) => {
    if (!repoPathOrUrl || !preview || applyBlocked) return;
    if (preview.nameCollision && !overwrite) {
      setOverwriteConfirm(true);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const response = await apiClient.request('promoteWorkflow', {
        body: promotionApplyRequest(
          repoPathOrUrl,
          name,
          input,
          preview.previewId,
          {
            hooks,
            tagChoiceBySourceId: tagChoices,
            bookChoices,
            overwrite,
            adopt,
          }
        ),
      });
      if (!('data' in response) || response.data.mode !== 'apply')
        throw new Error('Invalid promotion apply response');
      dispatch(
        triggerToast({
          title: 'Workflow saved',
          description: `${name}.json was written to ${getRepoName(repoPathOrUrl)}.`,
          variant: 'success',
        })
      );
      onOpenChange(false);
      onPromoted(repoPathOrUrl, name);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        dispatch(
          triggerToast({
            title: 'Promotion preview is stale',
            description:
              cause.body.code === 'PROMOTION_BOOK_CONFLICT'
                ? 'The target address book changed. Review the refreshed entries before applying.'
                : 'Repository state changed. Review the refreshed preview before applying.',
            variant: 'warning',
            duration: 7000,
          })
        );
        await requestPreview();
      } else {
        const description =
          cause instanceof ApiError
            ? formatApiError(cause).description
            : cause instanceof Error
              ? cause.message
              : String(cause);
        setError(description);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content glass-overlay"
            style={{ maxWidth: 680, width: '92vw', padding: 24 }}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">
                  Save as workflow
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  Ignite records committed source revisions but never pushes
                  them. Make sure every selected commit is available from its
                  remote.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  className="btn btn-secondary btn-icon"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="grid gap-4 max-h-[70vh] overflow-y-auto pr-1">
              <label className="grid gap-1">
                <span className="eyebrow">Target repository</span>
                <Select
                  requireSelection
                  value={repoPathOrUrl}
                  options={repoOptions}
                  placeholder="Choose a registered repository"
                  onValueChange={(value) => {
                    setRepoPathOrUrl(value);
                    resetPreview();
                  }}
                />
              </label>
              <label className="grid gap-1">
                <span className="eyebrow">Workflow name</span>
                <input
                  className="input-glass"
                  value={name}
                  placeholder="release-v1"
                  onChange={(event) => {
                    setName(event.target.value);
                    resetPreview();
                  }}
                />
                {name && !promotionNameValid(name) && (
                  <span className="text-xs text-err">
                    Use lowercase letters, numbers, hyphens, or underscores;
                    maximum 64 characters.
                  </span>
                )}
              </label>
              {!preview && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={previewBlocked || loading}
                    onClick={() => void requestPreview()}
                  >
                    {loading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Save size={14} />
                    )}{' '}
                    Preview pins
                  </button>
                  {/* A silently disabled button reads as a dead end — say
                      what's missing (same posture as the wizard nav). */}
                  {previewBlocked && (
                    <span className="text-sm text-muted">
                      {!repoPathOrUrl
                        ? 'Choose a target repository first'
                        : !name
                          ? 'Enter a workflow name first'
                          : 'Fix the workflow name first'}
                    </span>
                  )}
                </div>
              )}
              {preview && (
                <section className="grid gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Pinned sources</h3>
                    {preview.nameCollision && (
                      <span className="chip chip-warn">
                        Name already exists
                      </span>
                    )}
                  </div>
                  <div className="glass-list">
                    {preview.sources.map((source) => (
                      <div
                        key={source.sourceId}
                        className="list-row grid gap-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium mono-data flex-1">
                            {decodeUrlEncodingForDisplay(source.sourceId)}
                          </span>
                          <span className="chip">
                            {source.commit.slice(0, 7)}
                          </span>
                          {source.dirty && (
                            <span className="chip chip-warn">
                              <AlertTriangle size={12} /> dirty
                            </span>
                          )}
                        </div>
                        <div className="mono-data text-muted break-all">
                          {source.origin || 'No origin remote'}
                        </div>
                        {source.dirty && (
                          <div className="text-xs text-warn">
                            Uncommitted changes are not included in this
                            workflow pin.
                          </div>
                        )}
                        {source.error && (
                          <div className="text-sm text-err">{source.error}</div>
                        )}
                        {source.tagChoices.length > 1 && (
                          <label className="grid gap-1">
                            <span className="eyebrow">Tag at HEAD</span>
                            <Select
                              requireSelection
                              value={tagChoices[source.sourceId]}
                              options={source.tagChoices.map((tag) => ({
                                value: tag,
                                label: tag,
                              }))}
                              placeholder="Choose a tag"
                              onValueChange={(tag) =>
                                setTagChoices((current) => ({
                                  ...current,
                                  [source.sourceId]: tag,
                                }))
                              }
                            />
                          </label>
                        )}
                      </div>
                    ))}
                  </div>
                  {preview.referencedEntries.length > 0 && (
                    <section className="grid gap-2">
                      <h3 className="font-semibold">
                        Referenced address book entries
                      </h3>
                      <div className="glass-list">
                        {preview.referencedEntries.map((entry) => {
                          const choice = bookChoices[entry.name];
                          return (
                            <div
                              key={entry.name}
                              className="list-row grid gap-2"
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-medium mono-data flex-1">
                                  {entry.name}
                                </span>
                                <span className="chip">
                                  {entry.source === 'repo'
                                    ? 'repo book'
                                    : 'local book'}
                                </span>
                                {entry.conflict && (
                                  <span className="chip chip-warn">
                                    address conflict
                                  </span>
                                )}
                              </div>
                              {Object.entries(entry.resolutions).map(
                                ([chainId, address]) => (
                                  <div
                                    key={chainId}
                                    className="text-xs mono-data text-muted"
                                  >
                                    Chain {chainId}: {address}
                                  </div>
                                )
                              )}
                              {entry.conflict && (
                                <div className="grid gap-2">
                                  <label className="flex items-start gap-2 text-sm">
                                    <input
                                      type="radio"
                                      name={`book-${entry.name}`}
                                      checked={choice?.action === 'keep-repo'}
                                      onChange={() =>
                                        setBookChoices((current) => ({
                                          ...current,
                                          [entry.name]: { action: 'keep-repo' },
                                        }))
                                      }
                                    />
                                    <span>
                                      Keep the repo entry. The promoted pointer
                                      will retarget to the repo address.
                                    </span>
                                  </label>
                                  <label className="flex items-start gap-2 text-sm">
                                    <input
                                      type="radio"
                                      name={`book-${entry.name}`}
                                      checked={
                                        choice?.action === 'copy-under-new-name'
                                      }
                                      onChange={() =>
                                        setBookChoices((current) => ({
                                          ...current,
                                          [entry.name]: {
                                            action: 'copy-under-new-name',
                                            name: `${entry.name}-2`,
                                          },
                                        }))
                                      }
                                    />
                                    <span>
                                      Copy this entry and rewrite the promoted
                                      pointer.
                                    </span>
                                  </label>
                                  {choice?.action === 'copy-under-new-name' && (
                                    <input
                                      className="input-glass mono-data"
                                      aria-label={`New name for ${entry.name}`}
                                      value={choice.name}
                                      onChange={(event) =>
                                        setBookChoices((current) => ({
                                          ...current,
                                          [entry.name]: {
                                            action: 'copy-under-new-name',
                                            name: event.target.value.toLowerCase(),
                                          },
                                        }))
                                      }
                                    />
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </section>
              )}
              {'runId' in input && preview && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={adopt}
                    onChange={(event) => setAdopt(event.target.checked)}
                  />
                  <span>
                    Also record this run’s deployment (addresses, tx hashes) in
                    the workflow repository, so future runs can suggest reusing
                    the deployed contracts.
                  </span>
                </label>
              )}
              {error && <div className="text-sm text-err">{error}</div>}
              {preview && (
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={loading}
                    onClick={() => void requestPreview()}
                  >
                    Refresh preview
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={applyBlocked || loading}
                    onClick={() => void apply()}
                  >
                    {loading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Save size={14} />
                    )}{' '}
                    Apply
                  </button>
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={overwriteConfirm}
        onOpenChange={setOverwriteConfirm}
        title="Overwrite existing workflow?"
        description={`${name}.json already exists in the target repository.`}
        confirmText="Overwrite"
        variant="warning"
        onConfirm={() => void apply(true)}
      />
    </>
  );
}
