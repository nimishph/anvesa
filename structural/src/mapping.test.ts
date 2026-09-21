import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '@sutras/code-lens-core';
import { MappingConflictError, MappingInvalidError, MappingNotFoundError } from './errors.ts';
import {
  builtinMappings,
  compileMapping,
  type LanguageMapping,
  MappingRegistry,
  validateMapping,
} from './mapping.ts';

const valid = (): Record<string, unknown> => ({
  name: 'demo',
  extensions: ['.demo'],
  nodeTypeMap: { fn_decl: 'function', klass: 'class' },
  structuralTags: ['function', 'class'],
  nameExtractors: { fn_decl: 'identifier' },
});

function invalid(raw: unknown): MappingInvalidError {
  try {
    validateMapping(raw, 'test.json');
  } catch (thrown) {
    if (thrown instanceof MappingInvalidError) return thrown;
    throw thrown;
  }
  throw new InvariantViolationError('expected validation to fail');
}

describe('validateMapping', () => {
  test('accepts a well-formed mapping and the bundled ones', () => {
    expect(validateMapping(valid()).name).toBe('demo');
    expect(builtinMappings().map((b) => b.mapping.name)).toEqual(['typescript', 'python', 'php']);
  });

  test('a legacy maxDepth is accepted and ignored', () => {
    expect(validateMapping({ ...valid(), maxDepth: 10 })).not.toHaveProperty('maxDepth');
  });

  test.each([
    [{ ...valid(), name: '' }, 'name'],
    [{ ...valid(), extensions: ['demo'] }, 'extensions[0]'],
    [{ ...valid(), extensions: 'x' }, 'extensions'],
    [{ ...valid(), nodeTypeMap: { a: 1 } }, 'nodeTypeMap.a'],
    [{ ...valid(), structuralTags: ['nowhere'] }, 'structuralTags[0]'],
    [{ ...valid(), nameExtractors: [] }, 'nameExtractors'],
    [{ ...valid(), callableTags: [1] }, 'callableTags[0]'],
    [{ ...valid(), version: 3 }, 'version'],
    [{ ...valid(), maxDepth: 'deep' }, 'maxDepth'],
    [{ ...valid(), symbolRules: { fn_decl: { kind: 'nonsense' } } }, 'symbolRules.fn_decl.kind'],
    [
      { ...valid(), symbolRules: { fn_decl: { kind: 'function', nameChild: 4 } } },
      'symbolRules.fn_decl.nameChild',
    ],
    [{ ...valid(), callRules: { call: { calleeChild: [] } } }, 'callRules.call.calleeChild'],
    [{ ...valid(), importRules: { imp: 'x' } }, 'importRules.imp'],
    ['nope', '(root)'],
    [null, '(root)'],
  ])('names the field that is wrong (%#)', (raw, location) => {
    expect(invalid(raw).context.location).toBe(location);
  });

  test('keeps typed rules when they are valid', () => {
    const mapping = validateMapping({
      ...valid(),
      symbolRules: { fn_decl: { kind: 'function', nameChild: 'identifier' } },
      importRules: { imp: { sourceChild: 'string' } },
    });
    expect(mapping.symbolRules?.fn_decl?.kind).toBe('function');
    expect(mapping.importRules?.imp?.sourceChild).toBe('string');
  });
});

describe('compileMapping', () => {
  const compiled = compileMapping(validateMapping(valid()));

  test('maps node types to tags, leaving unlisted ones as they are', () => {
    expect(compiled.tagOf('fn_decl')).toBe('function');
    expect(compiled.tagOf('unlisted')).toBe('unlisted');
  });

  test('answers structural, callable and name questions', () => {
    expect(compiled.isStructural('class')).toBe(true);
    expect(compiled.isStructural('comment')).toBe(false);
    expect(compiled.isCallable('function')).toBe(true);
    expect(compiled.isCallable('class')).toBe(false);
    expect(compiled.nameChildType('fn_decl')).toBe('identifier');
    expect(compiled.nameChildType('klass')).toBeUndefined();
  });

  test('a mapping can declare its own callable tags', () => {
    const custom = compileMapping({
      ...(valid() as unknown as LanguageMapping),
      callableTags: ['class'],
    });
    expect(custom.isCallable('class')).toBe(true);
    expect(custom.isCallable('function')).toBe(false);
  });
});

describe('MappingRegistry', () => {
  test('one mapping serves several languages', () => {
    const registry = new MappingRegistry();
    const ts = registry.require('typescript');
    for (const language of ['javascript', 'tsx', 'vue']) {
      expect(registry.require(language)).toBe(ts);
    }
    expect(registry.require('python').mapping.name).toBe('python');
  });

  test('a language without a mapping is an error that lists what is known', () => {
    try {
      new MappingRegistry().require('cobol');
      throw new InvariantViolationError('expected a failure');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(MappingNotFoundError);
      expect((thrown as MappingNotFoundError).context.known).toContain('typescript');
    }
  });

  test('registering a duplicate name or language is a conflict, and changes nothing', () => {
    const registry = new MappingRegistry();
    const before = registry.languages().length;
    const extra = validateMapping({ ...valid(), name: 'other' });
    expect(() => registry.register(extra, { languages: ['python'] })).toThrow(MappingConflictError);
    expect(() => registry.register(validateMapping({ ...valid(), name: 'python' }))).toThrow(
      MappingConflictError,
    );
    expect(registry.languages()).toHaveLength(before);
  });

  test('a new mapping can be added for a new language', () => {
    const registry = new MappingRegistry();
    registry.register(validateMapping(valid()), { languages: ['demo', 'demo2'] });
    expect(registry.has('demo2')).toBe(true);
  });

  test('registries do not share state', () => {
    const a = new MappingRegistry();
    const b = new MappingRegistry();
    a.register(validateMapping(valid()));
    expect(b.has('demo')).toBe(false);
  });
});
