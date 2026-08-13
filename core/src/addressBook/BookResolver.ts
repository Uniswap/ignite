import { encodeFunctionData, toFunctionSignature, type AbiFunction, type AbiParameter } from 'viem';
import {
  BookPointerSchema,
  EncodedCallValueSchema,
  type ArgValues,
  type BookResolutions,
  type DeploymentPlan,
  type FrozenInputs,
  type Hex,
  type WorkflowRunBinding,
} from '@ignite/api';
import { IgniteError } from '../types/errors.js';
import { callAbiItem, callTargetAbi as resolveCallTargetAbi, mergeArgs, toConstructorArgs } from '../deployments/resolver.js';
import { AddressBookService, resolveBookEntry } from './AddressBookService.js';

export interface BookResolverDeps {
  books: Pick<AddressBookService, 'contextual'>;
}

export async function resolveBookPointers(
  plan: DeploymentPlan,
  frozen: FrozenInputs,
  profileId: string,
  workflow: WorkflowRunBinding | undefined,
  deps: BookResolverDeps = { books: new AddressBookService() },
): Promise<{ plan: DeploymentPlan; bookResolutions?: BookResolutions; bookHashes?: Record<string, string> }> {
  if (!containsBook(plan.steps)) return { plan };
  const book = await deps.books.contextual(profileId, workflow);
  const next = globalThis.structuredClone(plan);
  const bookResolutions: BookResolutions = {};
  for (const chainId of next.chains) {
    const resolutions: NonNullable<BookResolutions[string]> = [];
    for (const step of next.steps) {
      const input = step.kind === 'deploy'
        ? frozen[step.contractId]?.abi
        : resolveCallTargetAbi(next, step, chainId, frozen);
      const parameters = step.kind === 'deploy'
        ? constructorInputs(input)
        : callInputs(step, chainId, input);
      const merged = mergeArgs(step, chainId);
      for (let index = 0; index < parameters.length; index += 1) {
        const parameter = parameters[index]!;
        const key = parameter.name || `arg${index}`;
        if (!Object.prototype.hasOwnProperty.call(merged, key)) continue;
        const raw = merged[key];
        if (!containsBook(raw)) continue;
        const value = resolveValue(parameter, raw, `args.${key}`, {
          stepId: step.id,
          chainId,
          plan: next,
          frozen,
          entries: book.file.entries,
          source: book.source,
          bookHash: book.bookHash,
          resolutions,
        });
        (step.argsPerChain ??= {})[String(chainId)] = {
          ...(step.argsPerChain?.[String(chainId)] ?? {}),
          [key]: value,
        };
      }
      // No ABI means this field cannot be an ABI address position. The same
      // strict rule covers malformed call signatures before regular validation.
      for (const [key, value] of Object.entries(merged)) {
        if (containsBook(value) && !parameters.some((parameter, index) => (parameter.name || `arg${index}`) === key))
          throw invalidPosition(step.id, `args.${key}`);
      }
    }
    if (resolutions.length) bookResolutions[String(chainId)] = resolutions;
  }
  stripBookPointers(next);
  return {
    plan: next,
    ...(Object.keys(bookResolutions).length ? { bookResolutions, bookHashes: { [book.sourceKey]: book.bookHash } } : {}),
  };
}

function constructorInputs(abi: unknown): AbiParameter[] {
  if (!Array.isArray(abi)) return [];
  const constructor = abi.find((entry) => entry && typeof entry === 'object' && (entry as { type?: string }).type === 'constructor') as { inputs?: AbiParameter[] } | undefined;
  return constructor?.inputs ?? [];
}

function callInputs(step: Extract<DeploymentPlan['steps'][number], { kind: 'call' }>, chainId: number, abi: unknown): readonly AbiParameter[] {
  if (!step.signature) return [];
  try { return callAbiItem(step, chainId, abi)?.inputs ?? []; }
  catch { return []; }
}

type ResolveContext = {
  stepId: string;
  chainId: number;
  plan: DeploymentPlan;
  frozen: FrozenInputs;
  entries: Array<{ name: string; address?: Hex; perChain?: Record<string, Hex> }>;
  source: 'local' | 'repo';
  bookHash: string;
  resolutions: NonNullable<BookResolutions[string]>;
};

function resolveValue(parameter: AbiParameter, value: unknown, path: string, context: ResolveContext): unknown {
  if (hasBookKey(value)) {
    const parsed = BookPointerSchema.safeParse(value);
    if (!parsed.success) throw invalidPointer(context.stepId, path, 'Malformed $book pointer');
    if (parameter.type !== 'address') throw invalidPosition(context.stepId, path);
    const entry = context.entries.find((candidate) => candidate.name === parsed.data.$book.name);
    const address = entry && resolveBookEntry(entry, context.chainId);
    if (!entry || !address)
      throw new IgniteError(`Address book entry ${parsed.data.$book.name} is unresolved on chain ${context.chainId} at ${path}`, 'BOOK_ENTRY_UNRESOLVED', { stepId: context.stepId, argPath: path, entry: parsed.data.$book.name, chainId: context.chainId });
    context.resolutions.push({ stepId: context.stepId, argPath: path, entry: entry.name, address, source: context.source, bookHash: context.bookHash });
    return address;
  }
  if (hasEncodeKey(value)) {
    const encoded = EncodedCallValueSchema.safeParse(value);
    if (!encoded.success) throw invalidPointer(context.stepId, path, 'Malformed $encode value');
    if (parameter.type !== 'bytes') throw invalidPosition(context.stepId, path);
    const abi = context.frozen[encoded.data.$encode.contractId]?.abi;
    if (!Array.isArray(abi)) throw new IgniteError(`Encoded call contract ${encoded.data.$encode.contractId} is not frozen`, 'ENCODED_CALL_CONTRACT_NOT_FOUND', { stepId: context.stepId, argPath: path });
    const fn = abi.find((item): item is AbiFunction => {
      if (!item || typeof item !== 'object' || (item as { type?: string }).type !== 'function') return false;
      try { return toFunctionSignature(item as AbiFunction) === encoded.data.$encode.fn; } catch { return false; }
    });
    if (!fn) throw new IgniteError(`Encoded call function ${encoded.data.$encode.fn} is not in the frozen ABI`, 'ENCODED_CALL_FUNCTION_NOT_FOUND', { stepId: context.stepId, argPath: path });
    const args: ArgValues = {};
    for (let index = 0; index < fn.inputs.length; index += 1) {
      const input = fn.inputs[index]!;
      const key = input.name || `arg${index}`;
      if (Object.prototype.hasOwnProperty.call(encoded.data.$encode.args ?? {}, key))
        args[key] = resolveValue(input, encoded.data.$encode.args![key], `${path}.$encode.${key}`, context);
    }
    return encodeFunctionData({ abi: [fn], functionName: fn.name, args: toConstructorArgs(fn.inputs, args, 'call') as never });
  }
  const array = parameter.type.match(/^(.*)\[([0-9]*)\]$/);
  if (array && Array.isArray(value))
    return value.map((item, index) => resolveValue({ ...parameter, type: array[1]! }, item, `${path}[${index}]`, context));
  if (parameter.type === 'tuple' && value && typeof value === 'object') {
    const components = (parameter as AbiParameter & { components?: readonly AbiParameter[] }).components ?? [];
    if (Array.isArray(value)) return value.map((item, index) => resolveValue(components[index]!, item, `${path}.${components[index]?.name || `arg${index}`}`, context));
    return Object.fromEntries(components.map((component, index) => {
      const key = component.name || `arg${index}`;
      return [key, resolveValue(component, (value as Record<string, unknown>)[key], `${path}.${key}`, context)];
    }));
  }
  return value;
}

function containsBook(value: unknown): boolean {
  if (hasBookKey(value)) return true;
  if (Array.isArray(value)) return value.some(containsBook);
  return Boolean(value && typeof value === 'object' && Object.values(value as Record<string, unknown>).some(containsBook));
}

function hasBookKey(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '$book'));
}

function hasEncodeKey(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '$encode'));
}

function stripBookPointers(plan: DeploymentPlan): void {
  for (const step of plan.steps) {
    if (step.args) stripObject(step.args);
    if (step.argsPerChain) Object.values(step.argsPerChain).forEach(stripObject);
  }
}

function stripObject(value: Record<string, unknown>): void {
  for (const [key, child] of Object.entries(value)) {
    if (hasBookKey(child)) delete value[key];
    else if (Array.isArray(child)) child.forEach((item) => { if (item && typeof item === 'object') stripObject(item as Record<string, unknown>); });
    else if (child && typeof child === 'object') stripObject(child as Record<string, unknown>);
  }
}

function invalidPosition(stepId: string, argPath: string): IgniteError {
  return new IgniteError(`$book pointer at ${argPath} is only valid for address ABI inputs`, 'BOOK_POINTER_INVALID_POSITION', { stepId, argPath });
}

function invalidPointer(stepId: string, argPath: string, message: string): IgniteError {
  return new IgniteError(`${message} at ${argPath}`, 'BOOK_POINTER_INVALID', { stepId, argPath });
}
